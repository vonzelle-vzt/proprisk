import { tenantDb } from '@/lib/db/tenant-scoped';

/**
 * Usage metering. Pricing is tiered by funded accounts monitored, so this is
 * the one number the whole billing surface is built on: entitlement checks
 * read it live, and the metering cron persists it into `usage_snapshots` so
 * usage over time is auditable rather than only ever knowing the instant.
 *
 * Read-only by construction — this module only counts rows via `tenantDb()`,
 * which cannot write with an omitted tenant scope, and never touches
 * `accounts.is_active` or anything else that would change what is actually
 * monitored. Metering must never become a mechanism for stopping monitoring.
 */

/**
 * Funded accounts currently monitored for a tenant: active accounts in the
 * `funded` phase. Challenge/verification-phase accounts are not counted —
 * they are evaluated too, but the pricing promise (and the product's own
 * cost to serve) is driven by the funded book, not the funnel above it.
 */
export async function countFundedAccountsMonitored(tenantId: string): Promise<number> {
  const db = tenantDb(tenantId, 'metering.countFundedAccountsMonitored');
  const { count, error } = await db
    .select('accounts', 'id', { count: 'exact' })
    .eq('phase', 'funded')
    .eq('is_active', true);

  if (error) throw error;
  return count ?? 0;
}

/**
 * Persist a usage snapshot for a tenant. Append-only: this INSERTs a new row
 * rather than upserting, so historical usage is never overwritten.
 */
export async function recordUsageSnapshot(tenantId: string): Promise<number> {
  const fundedAccountsMonitored = await countFundedAccountsMonitored(tenantId);
  const db = tenantDb(tenantId, 'metering.recordUsageSnapshot');
  const { error } = await db.insert('usage_snapshots', {
    funded_accounts_monitored: fundedAccountsMonitored,
  });

  if (error) throw error;
  return fundedAccountsMonitored;
}
