import { tenantDb } from '@/lib/db/tenant-scoped';
import { executeDeduction } from '@/lib/deductions/execute';
import { logAuditEvent } from '@/lib/deductions/audit';
import { assessAndRecommend } from '@/lib/enforcement/agent';
import { logInfo } from '@/lib/logging/logger';
import type { ViolationQueueJob } from '@/lib/queue/violations';

function isEnforcementAgentEnabled(): boolean {
  return process.env.ENFORCEMENT_AGENT_ENABLED === 'true';
}

/**
 * Processes one dequeued job for a single tenant's queue (see
 * src/lib/queue/violations.ts — the queue itself is namespaced per tenant, so
 * the caller already knows which tenant this job belongs to; `tenantId` is
 * threaded through here so every read/write stays inside that tenant via
 * `tenantDb`, matching the cross-tenant isolation guarantee background jobs
 * must hold (src/lib/db/tenant-scoped.ts).
 */
export async function processViolationJob(job: ViolationQueueJob, tenantId: string): Promise<boolean> {
  const db = tenantDb(tenantId, 'processViolationJob');
  const deductionAmount = job.deduction_amount || 0;

  // `tenantDb().select()` takes `table` as a bare `string`, so the
  // Postgrest client can't resolve the literal-table overload it needs to
  // infer a real row shape from the column list and falls back to
  // `GenericStringError` — `.returns<T>()` restores the shape this call
  // actually gets back.
  const { data: account } = await db
    .select('accounts', 'account_size, challenge_type, phase')
    .eq('id', job.account_id)
    .returns<{ account_size: number; challenge_type: string; phase: string }[]>()
    .single();

  if (!account) return false;

  // Prevent duplicate records for the same account/type in a short window.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: existing } = await db
    .select('violations', 'id')
    .eq('account_id', job.account_id)
    .eq('violation_type', job.type)
    .gte('detected_at', oneHourAgo)
    .limit(1);

  if (existing && existing.length > 0) return false;

  const useEnforcementAgent = isEnforcementAgentEnabled();

  const { data: violation, error } = await db
    .insert('violations', {
      account_id: job.account_id,
      violation_type: job.type,
      // When enforcement agent is enabled, leave status as 'detected' so the
      // agent can assess and recommend actions before execution.
      status: useEnforcementAgent
        ? 'detected'
        : deductionAmount > 0
          ? 'confirmed'
          : 'detected',
      severity: deductionAmount > 500 ? 'high' : deductionAmount > 100 ? 'medium' : 'low',
      details_json: job.details || {},
      related_trade_ids: job.related_trade_ids || [],
      deduction_amount: deductionAmount,
      phase: account.phase,
      challenge_type: account.challenge_type,
      account_size: account.account_size,
    })
    .select()
    .single();

  if (error || !violation) return false;

  let deductionExecuted = false;

  if (useEnforcementAgent) {
    // Enforcement agent path: assess severity, generate recommendations,
    // and insert into the enforcement queue for human review.
    const recommendations = await assessAndRecommend({
      ...job,
      details: { ...job.details, violation_id: violation.id },
    });

    logInfo('Enforcement agent processed violation', {
      category: 'internal',
      account_id: job.account_id,
      violation_id: violation.id,
      recommendation_count: recommendations.length,
    });
  } else {
    // Legacy path: execute deduction immediately
    if (deductionAmount > 0) {
      const deductionResult = await executeDeduction({
        account_id: job.account_id,
        violation_id: violation.id,
        amount: deductionAmount,
        reason: `Automated deduction for ${job.type} violation`,
        execution_type: 'automatic',
        violation_type: job.type,
      });
      deductionExecuted = deductionResult.success;
    }
  }

  await logAuditEvent({
    action_type: 'violation_job_processed',
    entity_type: 'violation',
    entity_id: violation.id,
    performed_by: 'system',
    details: {
      type: job.type,
      account_id: job.account_id,
      deduction_amount: deductionAmount,
      deduction_executed: deductionExecuted,
      enforcement_agent_enabled: useEnforcementAgent,
    },
  });

  return true;
}
