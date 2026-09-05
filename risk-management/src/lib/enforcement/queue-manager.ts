import { createAdminClient } from '@/lib/supabase/admin';
import { tenantDb } from '@/lib/db/tenant-scoped';
import { executeDeduction } from '@/lib/deductions/execute';
import { logAuditEvent } from '@/lib/deductions/audit';
import { logInfo, logError } from '@/lib/logging/logger';
import { reviewCase } from '@/lib/reviewer/agent';
import type {
  EnforcementRecommendation,
  EnforcementQueueSummary,
  BatchDecision,
  EscalationLevel,
  EnforcementActionType,
} from '@/types/enforcement';

interface QueueFilters {
  status?: string[];
  escalation_level?: string[];
  violation_type?: string[];
  account_id?: string;
  limit?: number;
  offset?: number;
}

/**
 * Fetch enforcement recommendations with optional filters.
 */
export async function getEnforcementQueue(
  filters?: QueueFilters
): Promise<EnforcementRecommendation[]> {
  const supabase = createAdminClient();
  let query = supabase
    .from('enforcement_queue')
    .select('*')
    .order('created_at', { ascending: false });

  if (filters?.status && filters.status.length > 0) {
    query = query.in('status', filters.status);
  }
  if (filters?.escalation_level && filters.escalation_level.length > 0) {
    query = query.in('escalation_level', filters.escalation_level);
  }
  if (filters?.violation_type && filters.violation_type.length > 0) {
    query = query.in('violation_type', filters.violation_type);
  }
  if (filters?.account_id) {
    query = query.eq('account_id', filters.account_id);
  }

  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    logError('Failed to fetch enforcement queue', error, {
      category: 'database',
      filters: JSON.stringify(filters),
    });
    return [];
  }

  logInfo('Enforcement queue fetched', {
    category: 'internal',
    result_count: data?.length ?? 0,
    filters: JSON.stringify({
      status: filters?.status,
      escalation_level: filters?.escalation_level,
      violation_type: filters?.violation_type,
      account_id: filters?.account_id,
      limit: filters?.limit,
      offset: filters?.offset,
    }),
  });

  return (data ?? []) as EnforcementRecommendation[];
}

/**
 * Aggregate summary of the enforcement queue.
 */
export async function getQueueSummary(): Promise<EnforcementQueueSummary> {
  const supabase = createAdminClient();

  const { data: pending, error } = await supabase
    .from('enforcement_queue')
    .select('*')
    .eq('status', 'pending');

  if (error) {
    logError('Failed to fetch queue summary', error, { category: 'database' });
    return {
      total_pending: 0,
      by_escalation: { normal: 0, elevated: 0, urgent: 0, critical: 0 },
      by_action_type: { deduction: 0, payout_hold: 0, account_restriction: 0, escalation: 0, warning: 0 },
      by_violation_type: {},
      total_recommended_amount: 0,
      oldest_pending_at: null,
    };
  }

  const rows = (pending ?? []) as EnforcementRecommendation[];

  const by_escalation: Record<EscalationLevel, number> = { normal: 0, elevated: 0, urgent: 0, critical: 0 };
  const by_action_type: Record<EnforcementActionType, number> = {
    deduction: 0,
    payout_hold: 0,
    account_restriction: 0,
    escalation: 0,
    warning: 0,
  };
  const by_violation_type: Record<string, number> = {};
  let total_recommended_amount = 0;
  let oldest_pending_at: string | null = null;

  for (const row of rows) {
    by_escalation[row.escalation_level] = (by_escalation[row.escalation_level] ?? 0) + 1;
    by_action_type[row.action_type] = (by_action_type[row.action_type] ?? 0) + 1;
    by_violation_type[row.violation_type] = (by_violation_type[row.violation_type] ?? 0) + 1;
    total_recommended_amount += row.recommended_amount ?? 0;

    if (!oldest_pending_at || row.created_at < oldest_pending_at) {
      oldest_pending_at = row.created_at;
    }
  }

  // Reviewer status counts (across all statuses, not just pending)
  const { data: allItems } = await supabase
    .from('enforcement_queue')
    .select('reviewer_status')
    .not('reviewer_status', 'is', null);

  const by_reviewer_status: Record<string, number> = {};
  for (const item of (allItems ?? []) as { reviewer_status: string }[]) {
    by_reviewer_status[item.reviewer_status] = (by_reviewer_status[item.reviewer_status] ?? 0) + 1;
  }

  return {
    total_pending: rows.length,
    by_escalation,
    by_action_type,
    by_violation_type,
    total_recommended_amount,
    oldest_pending_at,
    by_reviewer_status,
  };
}

export interface DecisionResult {
  success: boolean;
  error?: string;
}

/**
 * Approve a recommendation: execute the underlying action, then mark executed.
 */
export async function approveRecommendation(
  id: string,
  decidedBy: string,
  // Required, not optional: approval can trigger an instant reviewer run, and
  // the reviewer reconciles against a specific firm's ledger. An approval that
  // could not name its tenant would reconcile against the wrong books.
  tenantId: string,
  notes?: string
): Promise<DecisionResult> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();

  // Fetch the recommendation
  const { data: rec, error: fetchError } = await supabase
    .from('enforcement_queue')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !rec) {
    const msg = `Failed to fetch recommendation: ${fetchError?.message ?? 'Not found'}`;
    logError(msg, fetchError ?? new Error('Not found'), { category: 'database' });
    return { success: false, error: msg };
  }

  const recommendation = rec as EnforcementRecommendation;

  if (recommendation.status !== 'pending') {
    const msg = `Recommendation status is '${recommendation.status}', expected 'pending'`;
    logInfo(msg, { category: 'internal', recommendation_id: id });
    return { success: false, error: msg };
  }

  // Mark as approved
  const { error: approveError } = await supabase
    .from('enforcement_queue')
    .update({
      status: 'approved',
      decided_by: decidedBy,
      decided_at: now,
      decision_notes: notes ?? null,
      updated_at: now,
    })
    .eq('id', id);

  if (approveError) {
    const msg = `DB update failed: ${approveError.message}`;
    logError('Failed to mark recommendation as approved', approveError, {
      category: 'database',
      recommendation_id: id,
    });
    return { success: false, error: msg };
  }

  // Execute the action for deduction type (best-effort — does not block approval)
  let executionResult: Record<string, unknown> = {};
  if (recommendation.action_type === 'deduction' && recommendation.recommended_amount > 0) {
    try {
      const result = await executeDeduction({
        account_id: recommendation.account_id,
        violation_id: recommendation.violation_id ?? undefined,
        amount: recommendation.recommended_amount,
        reason: `Enforcement: ${recommendation.recommendation_reason}`,
        execution_type: 'automatic',
        violation_type: recommendation.violation_type as any,
      });

      executionResult = {
        success: result.success,
        deduction_id: result.deduction_id ?? null,
        error: result.error ?? null,
      };
    } catch (err) {
      logError('Deduction execution failed (non-blocking)', err, {
        category: 'internal',
        account_id: recommendation.account_id,
      });
      executionResult = { success: false, error: String(err) };
    }
  }

  // Mark as executed
  const { error: executeError } = await supabase
    .from('enforcement_queue')
    .update({
      status: 'executed',
      executed_at: new Date().toISOString(),
      execution_result: executionResult,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (executeError) {
    logError('Failed to mark recommendation as executed', executeError, {
      category: 'database',
      recommendation_id: id,
    });
    // Still return true — the approval itself succeeded
  }

  // Audit trail
  await logAuditEvent({
    action_type: 'enforcement_recommendation_approved',
    entity_type: 'enforcement',
    entity_id: id,
    performed_by: decidedBy,
    details: {
      account_id: recommendation.account_id,
      action_type: recommendation.action_type,
      recommended_amount: recommendation.recommended_amount,
      execution_result: executionResult,
      notes,
    },
  }).catch((err) => {
    logError('Audit log failed (non-blocking)', err, { category: 'internal' });
  });

  logInfo('Enforcement recommendation approved and executed', {
    category: 'internal',
    account_id: recommendation.account_id,
  });

  // Instant review: fire-and-forget — do NOT await so the response returns immediately
  if (recommendation.action_type === 'deduction' && process.env.REVIEWER_AGENT_ENABLED === 'true') {
    (async () => {
      try {
        const { data: updatedRec } = await supabase
          .from('enforcement_queue')
          .select('*')
          .eq('id', id)
          .single();

        if (updatedRec) {
          const reviewResult = await reviewCase(supabase, updatedRec as EnforcementRecommendation, tenantId);
          logInfo('Instant review completed after approval', {
            category: 'internal',
            account_id: recommendation.account_id,
            reviewer_status: reviewResult.status,
          });
        }
      } catch (err) {
        logError('Instant review failed (non-blocking)', err, {
          category: 'internal',
          account_id: recommendation.account_id,
        });
      }
    })();
  }

  return { success: true };
}

/**
 * Reject a recommendation.
 */
export async function rejectRecommendation(
  id: string,
  decidedBy: string,
  notes?: string
): Promise<DecisionResult> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();

  const { data: rec, error: fetchError } = await supabase
    .from('enforcement_queue')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !rec) {
    const msg = `Failed to fetch recommendation: ${fetchError?.message ?? 'Not found'}`;
    logError(msg, fetchError ?? new Error('Not found'), { category: 'database' });
    return { success: false, error: msg };
  }

  const recommendation = rec as EnforcementRecommendation;

  if (recommendation.status !== 'pending') {
    return { success: false, error: `Recommendation status is '${recommendation.status}', expected 'pending'` };
  }

  const { error: updateError } = await supabase
    .from('enforcement_queue')
    .update({
      status: 'rejected',
      decided_by: decidedBy,
      decided_at: now,
      decision_notes: notes ?? null,
      updated_at: now,
    })
    .eq('id', id);

  if (updateError) {
    const msg = `DB update failed: ${updateError.message}`;
    logError('Failed to reject recommendation', updateError, { category: 'database' });
    return { success: false, error: msg };
  }

  await logAuditEvent({
    action_type: 'enforcement_recommendation_rejected',
    entity_type: 'enforcement',
    entity_id: id,
    performed_by: decidedBy,
    details: {
      account_id: recommendation.account_id,
      action_type: recommendation.action_type,
      recommended_amount: recommendation.recommended_amount,
      notes,
    },
  }).catch((err) => {
    logError('Audit log failed (non-blocking)', err, { category: 'internal' });
  });

  return { success: true };
}

/**
 * Process a batch of approve/reject decisions.
 */
export async function batchDecision(
  decision: BatchDecision,
  tenantId: string
): Promise<{ approved: number; rejected: number; failed: number }> {
  let approved = 0;
  let rejected = 0;
  let failed = 0;

  for (const id of decision.recommendation_ids) {
    try {
      const result =
        decision.decision === 'approved'
          ? await approveRecommendation(id, decision.decided_by, tenantId, decision.notes)
          : await rejectRecommendation(id, decision.decided_by, decision.notes);

      if (result.success) {
        if (decision.decision === 'approved') approved++;
        else rejected++;
      } else {
        failed++;
      }
    } catch (err) {
      logError('Batch decision item failed', err, { category: 'internal' });
      failed++;
    }
  }

  logInfo('Batch decision completed', {
    category: 'internal',
    approved,
    rejected,
    failed,
  });

  return { approved, rejected, failed };
}

/**
 * Expire stale recommendations that have passed their expires_at timestamp.
 *
 * `tenantId` is required — this runs from /api/cron/enforce, a background
 * job, and must stay inside one tenant's enforcement_queue rows
 * (src/lib/db/tenant-scoped.ts).
 */
export async function expireStaleRecommendations(tenantId: string): Promise<number> {
  const db = tenantDb(tenantId, 'expireStaleRecommendations');
  const now = new Date().toISOString();

  const { data, error } = await db
    .update('enforcement_queue', { status: 'expired', updated_at: now })
    .eq('status', 'pending')
    .lt('expires_at', now)
    .select('id');

  if (error) {
    logError('Failed to expire stale recommendations', error, { category: 'database' });
    return 0;
  }

  const count = data?.length ?? 0;
  if (count > 0) {
    logInfo(`Expired ${count} stale enforcement recommendations`, { category: 'internal' });
  }

  return count;
}

/**
 * Fetch all enforcement history for a given account.
 */
export async function getAccountEnforcementHistory(
  accountId: string
): Promise<EnforcementRecommendation[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('enforcement_queue')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false });

  if (error) {
    logError('Failed to fetch account enforcement history', error, {
      category: 'database',
      account_id: accountId,
    });
    return [];
  }

  return (data ?? []) as EnforcementRecommendation[];
}
