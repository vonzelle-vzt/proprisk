import { createAdminClient } from '@/lib/supabase/admin';
import { tenantDb } from '@/lib/db/tenant-scoped';
import { fetchAccountMetrics, fetchLedgerEvents } from '@/lib/platform/client';
import { logAuditEvent } from '@/lib/deductions/audit';
import { logInfo, logError } from '@/lib/logging/logger';
import { withRetry } from '@/lib/reviewer/retry';
import { isPlatformHealthy } from '@/lib/reviewer/health-check';
import type { EnforcementRecommendation } from '@/types/enforcement';
import type { PlatformLedgerEvent } from '@/types/platform';
import type { ReviewerRunResult, DeductionMatch } from '@/types/reviewer';

const CONCURRENCY = 5;
const AMOUNT_TOLERANCE = 0.01;

/**
 * Match a deduction in the enforcement queue against the platform's actual data.
 *
 * Checks both the risk-violation-summary (byType breakdown) and ledger events
 * to determine if the platform has already applied the deduction.
 */
export function matchDeduction(
  enforcement: EnforcementRecommendation,
  metrics: { deductions: { totalDeductions: number; breakdownByType: Record<string, number> } | null },
  ledgerEvents: PlatformLedgerEvent[]
): DeductionMatch {
  const type = enforcement.violation_type;
  const expectedAmount = enforcement.recommended_amount;
  const notesParts: string[] = [];

  notesParts.push(`Checking violation type "${type}" for expected amount $${expectedAmount.toFixed(2)}`);

  // Step 1: Check violation summary (byType)
  const byType = metrics?.deductions?.breakdownByType ?? {};
  const summaryAmount = byType[type] ?? byType[type === '2_percent_cap' ? 'profit_cap' : type] ?? 0;

  notesParts.push(`platform violation summary byType: ${JSON.stringify(byType)}`);

  if (summaryAmount > 0 && summaryAmount >= expectedAmount - AMOUNT_TOLERANCE) {
    notesParts.push(
      `MATCH via violation summary: platform shows $${summaryAmount.toFixed(2)} for "${type}" (expected $${expectedAmount.toFixed(2)})`
    );
    return {
      matched: true,
      match_source: 'violation_summary',
      platform_amount: summaryAmount,
      notes: notesParts.join('\n'),
    };
  }

  // Step 2: Check ledger events for matching cash_oper
  const cashOps = ledgerEvents.filter((e) => e.event === 'cash_oper');
  notesParts.push(`Found ${cashOps.length} cash_oper ledger events to check`);

  const enforcementCreatedAt = new Date(enforcement.created_at).getTime();

  for (const event of cashOps) {
    const amount = Math.abs(Number(event.data?.amount ?? 0));
    const eventTime = new Date(event.time).getTime();
    const note = String(event.data?.note ?? event.data?.comment ?? '').toLowerCase();

    // Check: amount matches (within tolerance) AND event is after enforcement was created
    // AND note contains the violation type string
    if (
      amount > 0 &&
      Math.abs(amount - expectedAmount) <= AMOUNT_TOLERANCE &&
      eventTime >= enforcementCreatedAt &&
      (note.includes(type) || note.includes('deduction'))
    ) {
      notesParts.push(
        `MATCH via ledger event: amount=$${amount.toFixed(2)}, time=${event.time}, note="${event.data?.note ?? ''}"`
      );
      return {
        matched: true,
        match_source: 'ledger_event',
        platform_amount: amount,
        ledger_event_time: event.time,
        notes: notesParts.join('\n'),
      };
    }
  }

  // Step 3: No match found
  if (summaryAmount > 0) {
    notesParts.push(
      `NO MATCH: Summary shows $${summaryAmount.toFixed(2)} for "${type}" but below expected $${expectedAmount.toFixed(2)}`
    );
  } else {
    notesParts.push(`NO MATCH: No entry for "${type}" in platform violation summary`);
  }
  notesParts.push('No matching ledger event found after enforcement creation date');

  return {
    matched: false,
    match_source: 'none',
    notes: notesParts.join('\n'),
  };
}

/**
 * Process a single enforcement case: fetch platform data, match, and update status.
 */
export async function reviewCase(
  supabase: ReturnType<typeof createAdminClient>,
  rec: EnforcementRecommendation,
  tenantId: string
): Promise<{ status: 'confirmed' | 'pending_deduction' | 'error'; error?: string }> {
  const accountId = rec.account_id;
  const now = new Date().toISOString();

  try {
    // Fetch platform data with retries
    const [metricsResult, ledgerEvents] = await Promise.all([
      withRetry(
        () => fetchAccountMetrics(accountId, tenantId),
        `fetchAccountMetrics(${accountId})`
      ),
      withRetry(
        () => fetchLedgerEvents(accountId, undefined, tenantId),
        `fetchLedgerEvents(${accountId})`
      ),
    ]);

    // Match deduction
    const match = matchDeduction(rec, metricsResult, ledgerEvents);

    if (match.matched) {
      // Deduction confirmed on the platform
      await supabase
        .from('enforcement_queue')
        .update({
          reviewer_status: 'deduction_confirmed',
          reviewer_notes: match.notes,
          reviewed_at: now,
          updated_at: now,
        })
        .eq('id', rec.id);

      await logAuditEvent({
        action_type: 'reviewer_deduction_confirmed',
        entity_type: 'enforcement',
        entity_id: rec.id,
        performed_by: 'reviewer_agent',
        details: {
          account_id: accountId,
          violation_type: rec.violation_type,
          recommended_amount: rec.recommended_amount,
          match_source: match.match_source,
          platform_amount: match.platform_amount,
        },
      });

      return { status: 'confirmed' };
    } else {
      // Not yet deducted on the platform
      await supabase
        .from('enforcement_queue')
        .update({
          reviewer_status: 'pending_deduction',
          reviewer_notes: match.notes,
          reviewed_at: now,
          updated_at: now,
        })
        .eq('id', rec.id);

      await logAuditEvent({
        action_type: 'reviewer_pending_deduction',
        entity_type: 'enforcement',
        entity_id: rec.id,
        performed_by: 'reviewer_agent',
        details: {
          account_id: accountId,
          violation_type: rec.violation_type,
          recommended_amount: rec.recommended_amount,
        },
      });

      return { status: 'pending_deduction' };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    await supabase
      .from('enforcement_queue')
      .update({
        reviewer_status: 'review_error',
        reviewer_notes: `Error during review: ${errorMsg}`,
        reviewed_at: now,
        updated_at: now,
      })
      .eq('id', rec.id);

    return { status: 'error', error: errorMsg };
  }
}

/**
 * Main reviewer agent orchestrator.
 *
 * Runs nightly to cross-reference enforcement_queue deductions against the platform's
 * actual violation summary and ledger events. Updates reviewer_status on each case
 * with detailed notes for human verification.
 *
 * Phase 1: Review-only mode — no emails sent.
 */
export async function runReviewerAgent(tenantId: string): Promise<ReviewerRunResult> {
  const startedAt = new Date().toISOString();
  const db = tenantDb(tenantId, 'runReviewerAgent');
  // reviewCase() updates a single enforcement_queue row by its own (globally
  // unique) id, so a plain admin client is safe there; the tenant-list-scale
  // queries below (reviewer_runs, the enforcement_queue scan) use `db`.
  const rawClient = createAdminClient();

  // Check feature flag
  if (process.env.REVIEWER_AGENT_ENABLED !== 'true') {
    logInfo('Reviewer agent disabled via feature flag', { category: 'cron' });
    return {
      run_id: '',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      total_cases: 0,
      confirmed: 0,
      pending_deduction: 0,
      errors: 0,
      skipped: 0,
      platform_healthy: true,
    };
  }

  // Create run record
  const { data: runRow } = await db
    .insert('reviewer_runs', { started_at: startedAt, status: 'running' })
    .select('id')
    .single();

  const runId = runRow?.id ?? 'unknown';

  logInfo('Reviewer agent starting', { category: 'cron', run_id: runId });

  // Health check
  const healthy = await isPlatformHealthy();
  if (!healthy) {
    logInfo('Reviewer agent deferred: platform unhealthy', { category: 'cron', run_id: runId });

    await db
      .update('reviewer_runs', {
        status: 'deferred',
        completed_at: new Date().toISOString(),
        platform_healthy: false,
      })
      .eq('id', runId);

    return {
      run_id: runId,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      total_cases: 0,
      confirmed: 0,
      pending_deduction: 0,
      errors: 0,
      skipped: 0,
      platform_healthy: false,
    };
  }

  // Gather reviewable cases. `.returns<T>()` restores the row shape lost to
  // `GenericStringError` because `tenantDb().select()` takes `table` as a
  // bare `string` (see also src/lib/violations/worker.ts).
  const { data: cases, error: fetchError } = await db
    .select('enforcement_queue', '*')
    .in('status', ['approved', 'executed'])
    .eq('action_type', 'deduction')
    .is('reviewer_status', null)
    .order('created_at', { ascending: true })
    .returns<EnforcementRecommendation[]>();

  if (fetchError) {
    logError('Reviewer agent: failed to fetch cases', fetchError, { category: 'database' });

    await db
      .update('reviewer_runs', {
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_details: { message: fetchError.message },
      })
      .eq('id', runId);

    return {
      run_id: runId,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      total_cases: 0,
      confirmed: 0,
      pending_deduction: 0,
      errors: 1,
      skipped: 0,
      platform_healthy: true,
    };
  }

  const items = (cases ?? []) as EnforcementRecommendation[];
  const totalCases = items.length;

  logInfo(`Reviewer agent: ${totalCases} cases to review`, { category: 'cron', run_id: runId });

  let confirmed = 0;
  let pendingDeduction = 0;
  let errors = 0;

  // Process in batches with concurrency limit
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((rec) => reviewCase(rawClient, rec, tenantId))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        switch (result.value.status) {
          case 'confirmed':
            confirmed++;
            break;
          case 'pending_deduction':
            pendingDeduction++;
            break;
          case 'error':
            errors++;
            break;
        }
      } else {
        errors++;
        logError('Reviewer agent: case processing rejected', result.reason, {
          category: 'internal',
        });
      }
    }
  }

  const completedAt = new Date().toISOString();

  // Update run record
  await db
    .update('reviewer_runs', {
      status: 'completed',
      completed_at: completedAt,
      total_cases: totalCases,
      confirmed,
      pending_deduction: pendingDeduction,
      errors,
      skipped: 0,
      platform_healthy: true,
    })
    .eq('id', runId);

  // Audit trail
  await logAuditEvent({
    action_type: 'reviewer_agent_run_completed',
    entity_type: 'reviewer_run',
    entity_id: runId,
    performed_by: 'reviewer_agent',
    details: {
      total_cases: totalCases,
      confirmed,
      pending_deduction: pendingDeduction,
      errors,
      duration_ms: Date.now() - new Date(startedAt).getTime(),
    },
  });

  logInfo('Reviewer agent completed', {
    category: 'cron',
    run_id: runId,
    total_cases: totalCases,
    confirmed,
    pending_deduction: pendingDeduction,
    errors,
  });

  return {
    run_id: runId,
    started_at: startedAt,
    completed_at: completedAt,
    total_cases: totalCases,
    confirmed,
    pending_deduction: pendingDeduction,
    errors,
    skipped: 0,
    platform_healthy: true,
  };
}
