import { createAdminClient } from '@/lib/supabase/admin';
import { PLANS, PLAN_ORDER, isPlanTier, maxAccountsForTier, type PlanTier } from './plans';

/**
 * The `subscriptions` store, reached with the service-role client rather than
 * `tenantDb()`.
 *
 * This is a deliberate, narrow exception to "background work goes through
 * tenantDb()" (src/lib/db/tenant-scoped.ts): the Stripe webhook is the one
 * caller here, and it arrives with no session and often no tenant id at all
 * — a `customer.subscription.updated` event names a Stripe customer, not one
 * of our tenants, until this module resolves it. That is exactly the shape
 * `signup`/`invites/accept` already have (see check-isolation's
 * ALLOWED_ADMIN_CLIENT), and it is why the resolution lives in this
 * lib module rather than inline in the route handler: every write below
 * still stamps an explicit `tenant_id` it looked up itself, so a route
 * handler using this module can never issue an unscoped cross-tenant write —
 * only this module's own resolver functions read across tenants, and only by
 * `stripe_customer_id`, which is never caller-supplied from the request body.
 */

/** Reverse-map a Stripe Price id back to our plan tier via the configured env vars. */
export function tierForPriceId(priceId: string | null | undefined): PlanTier | null {
  if (!priceId) return null;
  for (const tier of PLAN_ORDER) {
    const envVar = PLANS[tier].stripePriceEnvVar;
    if (envVar && process.env[envVar] === priceId) return tier;
  }
  return null;
}

export interface UpsertSubscriptionInput {
  tenantId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  planTier: PlanTier;
  status: string;
  currentPeriodEnd: Date | null;
}

/** Sync one tenant's billing row from a Stripe event. Idempotent on `tenant_id`. */
export async function upsertSubscription(input: UpsertSubscriptionInput): Promise<void> {
  const sb = createAdminClient();
  const { error } = await sb.from('subscriptions').upsert(
    {
      tenant_id: input.tenantId,
      stripe_customer_id: input.stripeCustomerId,
      stripe_subscription_id: input.stripeSubscriptionId,
      plan_tier: input.planTier,
      status: input.status,
      max_accounts: maxAccountsForTier(input.planTier),
      current_period_end: input.currentPeriodEnd ? input.currentPeriodEnd.toISOString() : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'tenant_id' }
  );
  if (error) throw error;
}

/**
 * Resolve a tenant id from a Stripe customer id. Used only as a fallback for
 * events whose object doesn't itself carry `metadata.tenant_id` (every
 * subscription this app creates does — see checkout.ts — but defending
 * against a hand-created Stripe object without it is one lookup, not a risk).
 */
export async function findTenantIdByStripeCustomerId(customerId: string): Promise<string | null> {
  const sb = createAdminClient();
  const { data, error } = await sb
    .from('subscriptions')
    .select('tenant_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  if (error) throw error;
  return data?.tenant_id ?? null;
}

export { isPlanTier };
