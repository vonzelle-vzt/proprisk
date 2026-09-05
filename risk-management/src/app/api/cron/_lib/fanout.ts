import { listActiveTenantIds } from '@/lib/db/tenant-scoped';
import { logError } from '@/lib/logging/logger';

/**
 * Per-tenant cron fan-out.
 *
 * Every cron job in this platform now runs once per active tenant instead of
 * once globally — the pre-tenancy crons queried `createAdminClient()`
 * directly, which under a multi-tenant service-role connection silently mixed
 * every firm's accounts, violations and enforcement decisions into one scan.
 *
 * Two properties this helper guarantees so no cron route has to reimplement
 * them (and get them wrong) itself:
 *
 * 1. Bounded concurrency — a firm with 10x the accounts of everyone else
 *    should not be able to starve the others' runs by holding every worker
 *    slot for the whole `maxDuration` window.
 * 2. Isolation of failure — one tenant's job throwing (bad provider creds,
 *    a transient DB error) must not abort the batch. It is logged and the
 *    loop continues; the route's response reports that tenant as failed
 *    alongside every tenant that succeeded.
 */

export interface TenantOutcome<T> {
  tenant_id: string;
  ok: boolean;
  result?: T;
  error?: string;
}

export interface FanOutOptions {
  /** Max tenants processed concurrently. Default 3 — see module doc. */
  concurrency?: number;
  /** Name used in error logs, e.g. the cron route name. */
  jobName: string;
}

/**
 * Run `fn` once per active tenant, bounded by `concurrency`, with per-tenant
 * failure isolation. Returns one outcome per tenant, in no particular order
 * within a batch but batches run in the order tenants were listed.
 */
export async function fanOutToTenants<T>(
  fn: (tenantId: string) => Promise<T>,
  options: FanOutOptions
): Promise<TenantOutcome<T>[]> {
  const concurrency = options.concurrency ?? 3;
  const tenantIds = await listActiveTenantIds();
  const outcomes: TenantOutcome<T>[] = [];

  for (let i = 0; i < tenantIds.length; i += concurrency) {
    const batch = tenantIds.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map((tenantId) => fn(tenantId)));

    for (let j = 0; j < settled.length; j++) {
      const tenantId = batch[j];
      const outcome = settled[j];

      if (outcome.status === 'fulfilled') {
        outcomes.push({ tenant_id: tenantId, ok: true, result: outcome.value });
      } else {
        const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        logError(`${options.jobName}: tenant job failed`, outcome.reason, {
          category: 'cron',
          route: options.jobName,
          tenant_id: tenantId,
        });
        outcomes.push({ tenant_id: tenantId, ok: false, error: message });
      }
    }
  }

  return outcomes;
}
