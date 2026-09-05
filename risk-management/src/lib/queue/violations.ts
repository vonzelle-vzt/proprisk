import { getRedisClient } from '@/lib/redis/client';

/**
 * Tenant-namespaced Redis key. Before tenancy this was a single global key
 * (`queue:violations:pending`), so every firm's violation jobs shared one
 * FIFO — one tenant's backlog could starve another's, and (worse) there was
 * no way to even tell whose job was whose once it was in the list. Every
 * operation below now requires a tenantId and reads/writes only that
 * tenant's list.
 */
function queueKey(tenantId: string): string {
  return `queue:violations:pending:${tenantId}`;
}

/**
 * NOTE on `enqueueViolationJobs` (removed): it had zero callers anywhere in
 * the codebase — the only producer of violations, `/api/cron/detect-violations`,
 * writes directly to `enforcement_queue` and never touched this Redis queue.
 * Its `ViolationQueueJob.type` union was also stale (missing at least
 * `overnight`, `daily_loss`, `trailing_drawdown`, `position_limit`, `eod_flat`
 * from the futures rule set — see src/lib/evidence/builder.ts
 * RULE_DESCRIPTIONS), so "wire it up" would have meant designing a second,
 * parallel enforcement-recommendation path with its own type contract for a
 * queue nothing produces into. Deleting the dead producer is the smaller,
 * safer change; the consumer side (dequeue/depth, used by
 * /api/cron/process-violations) is kept and namespaced per tenant in case a
 * producer is added later.
 */
export interface ViolationQueueJob {
  account_id: string;
  type: 'overleveraging' | 'hft' | 'martingale' | 'news' | 'grid' | 'copy';
  deduction_amount: number;
  details: Record<string, unknown>;
  related_trade_ids: string[];
}

function queueEnabled() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

export async function dequeueViolationJob(tenantId: string): Promise<ViolationQueueJob | null> {
  if (!queueEnabled()) return null;
  const redis = getRedisClient();
  if (!redis) return null;
  const raw = await redis.lpop<string | null>(queueKey(tenantId));
  if (!raw) return null;

  try {
    return JSON.parse(raw) as ViolationQueueJob;
  } catch {
    return null;
  }
}

export async function getViolationQueueDepth(tenantId: string): Promise<number> {
  if (!queueEnabled()) return 0;
  const redis = getRedisClient();
  if (!redis) return 0;
  return await redis.llen(queueKey(tenantId));
}

export function isViolationQueueEnabled() {
  return queueEnabled();
}
