import { tenantDb, globalTable } from '@/lib/db/tenant-scoped';
import { countFundedAccountsMonitored } from './metering';
import { maxAccountsForTier } from './plans';

/**
 * Entitlement enforcement.
 *
 * DEGRADE GRACEFULLY IS THE ENTIRE POINT OF THIS MODULE. A firm going over
 * its plan's account ceiling (or falling behind on an invoice) must be warned
 * and blocked from onboarding NEW accounts — it must NEVER cause an account
 * this firm already has to stop being monitored. Silently stopping risk
 * monitoring because a subscription lapsed is the single worst failure mode
 * this product has: a firm's funded traders keep trading, unwatched, and the
 * firm finds out when a payout dispute has no evidence pack behind it.
 *
 * That guarantee is structural here, not just a comment: every function in
 * this module only *reads* (`countFundedAccountsMonitored`, plan lookups) and
 * returns a plain status object. Nothing here calls `accounts` UPDATE/DELETE,
 * touches the account-active flag, or reaches into the risk/violations/enforcement
 * pipeline. The only thing a caller can do with `canOnboardNewAccount()`
 * returning false is refuse to CREATE a new account — see
 * entitlements.test.ts, which asserts this module never issues a write.
 */

export interface EntitlementStatus {
  tenantId: string;
  planTier: string;
  /** Funded-account ceiling for this tenant's plan. `null` = unlimited (enterprise). */
  limit: number | null;
  /** Funded accounts currently monitored. */
  used: number;
  /** Current usage is at or under the plan ceiling. */
  withinLimit: boolean;
  /** There is room to onboard at least one more funded account without exceeding the ceiling. */
  canOnboardNewAccount: boolean;
  /** How far current usage exceeds the ceiling, if at all. 0 when within limit or unlimited. */
  overBy: number;
}

/**
 * A tenant's billed plan tier. `subscriptions` (synced from Stripe by the
 * webhook) is authoritative once it exists; a tenant that has signed up but
 * never completed checkout has no row there yet, so this falls back to the
 * tenant's nominal `plan_tier` (defaults to 'starter' at signup, see
 * 00015_tenancy.sql) rather than treating "hasn't paid yet" as zero
 * entitlement — that fallback is itself part of the graceful-degrade
 * contract: a billing-system hiccup must resolve to *some* usable tier, never
 * to none.
 */
async function resolvePlanTier(tenantId: string): Promise<string> {
  const db = tenantDb(tenantId, 'entitlements.resolvePlanTier');
  // tenantDb().select() widens the columns argument to `string`, which loses
  // supabase-js's literal-string column parsing (the same shape hits
  // GenericStringError in every other tenantDb() consumer with a
  // multi-column select — see src/lib/violations/worker.ts). Cast at this
  // one boundary rather than widening tenant-scoped.ts, which is out of
  // scope for this feature.
  const { data: subscription, error } = (await db
    .select('subscriptions', 'plan_tier')
    .maybeSingle()) as { data: { plan_tier: string } | null; error: { message: string } | null };
  if (error) throw error;
  if (subscription?.plan_tier) return subscription.plan_tier;

  const { data: tenant, error: tenantError } = await globalTable('tenants')
    .select('plan_tier')
    .eq('id', tenantId)
    .maybeSingle();
  if (tenantError) throw tenantError;
  return tenant?.plan_tier ?? 'starter';
}

export async function checkEntitlement(tenantId: string): Promise<EntitlementStatus> {
  const [planTier, used] = await Promise.all([
    resolvePlanTier(tenantId),
    countFundedAccountsMonitored(tenantId),
  ]);

  const limit = maxAccountsForTier(planTier);
  const withinLimit = limit === null || used <= limit;
  const canOnboardNewAccount = limit === null || used < limit;
  const overBy = limit === null ? 0 : Math.max(0, used - limit);

  return { tenantId, planTier, limit, used, withinLimit, canOnboardNewAccount, overBy };
}

/**
 * The single check other code should call before onboarding a new funded
 * account. Returns `true` (never blocks) for unlimited/enterprise plans.
 */
export async function canOnboardNewAccount(tenantId: string): Promise<boolean> {
  const status = await checkEntitlement(tenantId);
  return status.canOnboardNewAccount;
}

/**
 * Human-readable warning for a tenant at or over its ceiling, for the
 * onboarding-blocked response and any admin-facing banner. Returns `null`
 * when there is nothing to warn about — callers should not render a banner
 * in that case.
 */
export function formatEntitlementWarning(status: EntitlementStatus): string | null {
  if (status.limit === null) return null;
  if (status.canOnboardNewAccount) return null;

  return status.overBy > 0
    ? `This plan (${status.planTier}) is limited to ${status.limit} funded accounts monitored, and you currently have ${status.used} — ${status.overBy} over. Existing accounts keep being monitored, but no new funded account can be onboarded until you upgrade.`
    : `This plan (${status.planTier}) is limited to ${status.limit} funded accounts monitored, and you are at that limit. Existing accounts keep being monitored, but a new funded account cannot be onboarded until you upgrade.`;
}
