import { createAdminClient } from '@/lib/supabase/admin';
import { logAuditEvent } from '@/lib/deductions/audit';
import { assessSeverity, computeRepeatMultiplier } from '@/lib/enforcement/severity';
import { logInfo, logError } from '@/lib/logging/logger';
import type { ViolationQueueJob } from '@/lib/queue/violations';
import type {
  EnforcementRecommendation,
  AccountViolationHistory,
  EscalationLevel,
} from '@/types/enforcement';

/**
 * Fetch violation history rows for an account from account_violation_history.
 */
export async function getAccountHistory(accountId: string): Promise<AccountViolationHistory[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('account_violation_history')
    .select('*')
    .eq('account_id', accountId);

  if (error) {
    logError('Failed to fetch account violation history', error, {
      category: 'database',
      account_id: accountId,
    });
    return [];
  }

  return (data ?? []) as AccountViolationHistory[];
}

/**
 * Determine if an account has a ban flag matching the given violation type.
 */
function hasBanFlag(
  snapshot: Record<string, unknown> | null,
  violationType: string
): boolean {
  if (!snapshot) return false;
  const banMap: Record<string, string> = {
    news: 'ban_news_trading',
    hft: 'ban_hft',
    martingale: 'ban_mtgl',
    copy: 'ban_copy_trading',
  };
  const field = banMap[violationType];
  if (!field) return false;
  return snapshot[field] === 1 || snapshot[field] === true;
}

/**
 * Core enforcement agent orchestrator.
 *
 * Assesses a violation job, generates enforcement recommendations, persists
 * them to the enforcement_queue table, and updates the account's violation
 * history.
 */
export async function assessAndRecommend(
  job: ViolationQueueJob
): Promise<EnforcementRecommendation[]> {
  const supabase = createAdminClient();
  const accountId = job.account_id;

  try {
    // 1. Get account violation history
    const history = await getAccountHistory(accountId);

    // 2. Get account snapshot for context (age, pending payouts, ban flags)
    const { data: snapshot } = await supabase
      .from('account_snapshots')
      .select('*')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let accountAge: number | undefined;
    if (snapshot?.added_utc) {
      const createdDate = new Date(snapshot.added_utc as string);
      accountAge = Math.floor(
        (Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)
      );
    }

    // Check pending payouts from payout_history
    const { data: pendingPayouts } = await supabase
      .from('payout_history')
      .select('amount')
      .eq('account_id', accountId)
      .eq('decision', 'pending');

    const hasPendingPayout = (pendingPayouts?.length ?? 0) > 0;
    const pendingPayoutAmount = pendingPayouts?.reduce(
      (sum: number, p: { amount: number }) => sum + (p.amount ?? 0),
      0
    ) ?? 0;

    // 3. Assess severity
    const assessment = assessSeverity({
      violationType: job.type,
      deductionAmount: job.deduction_amount,
      history,
      accountAge,
      hasPendingPayout,
      pendingPayoutAmount,
      hasBanForType: hasBanFlag(snapshot, job.type),
    });

    logInfo('Severity assessment completed', {
      account_id: accountId,
      category: 'internal',
      severity_score: assessment.score,
      escalation_level: assessment.escalation_level,
      action_count: assessment.recommended_actions.length,
    });

    // 4. Build recommendation rows
    const sameTypeHistory = history.find((h) => h.violation_type === job.type);
    const priorCount = sameTypeHistory?.total_count ?? 0;
    const repeatMultiplier = computeRepeatMultiplier(sameTypeHistory?.count_last_30d ?? 0);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h TTL

    const rows = assessment.recommended_actions.map((action) => ({
      account_id: accountId,
      violation_id: (job.details?.violation_id as string) ?? null,
      violation_type: job.type,
      action_type: action.action_type,
      status: 'pending' as const,
      severity_score: assessment.score,
      escalation_level: assessment.escalation_level,
      recommended_amount: action.amount,
      recommendation_reason: action.reason,
      recommendation_details: {
        base_amount: job.deduction_amount,
        repeat_multiplier: repeatMultiplier,
        severity_factors: assessment.factors.map((f) => f.description),
        account_context: snapshot
          ? {
              plan: (snapshot.plan as string) ?? 'unknown',
              balance: (snapshot.balance as number) ?? 0,
              total_prior_deductions: sameTypeHistory?.total_deduction_amount ?? 0,
            }
          : undefined,
      },
      prior_violation_count: priorCount,
      repeat_multiplier: repeatMultiplier,
      expires_at: expiresAt,
    }));

    // 5. Insert recommendations into enforcement_queue
    const { data: inserted, error: insertError } = await supabase
      .from('enforcement_queue')
      .insert(rows)
      .select();

    if (insertError) {
      logError('Failed to insert enforcement recommendations', insertError, {
        category: 'database',
        account_id: accountId,
      });
      return [];
    }

    const recommendations = (inserted ?? []) as EnforcementRecommendation[];

    // 6. Upsert account_violation_history
    await upsertViolationHistory(supabase, accountId, job.type, job.deduction_amount, assessment.escalation_level);

    // 7. Log audit event
    await logAuditEvent({
      action_type: 'enforcement_recommendations_created',
      entity_type: 'enforcement',
      entity_id: recommendations[0]?.id ?? accountId,
      performed_by: 'enforcement_agent',
      details: {
        account_id: accountId,
        violation_type: job.type,
        severity_score: assessment.score,
        escalation_level: assessment.escalation_level,
        recommendation_count: recommendations.length,
        total_recommended_amount: recommendations.reduce((s, r) => s + r.recommended_amount, 0),
        repeat_multiplier: repeatMultiplier,
      },
    });

    logInfo('Enforcement recommendations created', {
      account_id: accountId,
      category: 'internal',
      recommendation_count: recommendations.length,
    });

    return recommendations;
  } catch (err) {
    logError('Enforcement agent failed', err, {
      category: 'internal',
      account_id: accountId,
    });
    return [];
  }
}

/**
 * Upsert the account_violation_history row for a given account + violation type.
 * Increments counts and updates the escalation tier.
 */
async function upsertViolationHistory(
  supabase: ReturnType<typeof createAdminClient>,
  accountId: string,
  violationType: string,
  deductionAmount: number,
  escalationLevel: EscalationLevel
): Promise<void> {
  const tierMap: Record<EscalationLevel, number> = {
    normal: 0,
    elevated: 1,
    urgent: 2,
    critical: 3,
  };

  const now = new Date().toISOString();

  // Try to get existing row
  const { data: existing } = await supabase
    .from('account_violation_history')
    .select('*')
    .eq('account_id', accountId)
    .eq('violation_type', violationType)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('account_violation_history')
      .update({
        total_count: (existing.total_count ?? 0) + 1,
        last_violation_at: now,
        total_deduction_amount: (existing.total_deduction_amount ?? 0) + deductionAmount,
        escalation_tier: Math.max(existing.escalation_tier ?? 0, tierMap[escalationLevel]),
        count_last_24h: (existing.count_last_24h ?? 0) + 1,
        count_last_7d: (existing.count_last_7d ?? 0) + 1,
        count_last_30d: (existing.count_last_30d ?? 0) + 1,
        updated_at: now,
      })
      .eq('id', existing.id);
  } else {
    await supabase.from('account_violation_history').insert({
      account_id: accountId,
      violation_type: violationType,
      total_count: 1,
      last_violation_at: now,
      total_deduction_amount: deductionAmount,
      escalation_tier: tierMap[escalationLevel],
      count_last_24h: 1,
      count_last_7d: 1,
      count_last_30d: 1,
      updated_at: now,
    });
  }
}
