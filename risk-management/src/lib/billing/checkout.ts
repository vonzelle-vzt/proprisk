import { tenantDb } from '@/lib/db/tenant-scoped';
import { getStripeClient } from './stripe-client';
import { PLANS, type PlanTier } from './plans';

export class MissingStripePriceError extends Error {}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? '';
}

// tenantDb().select() widens its columns argument to `string`, which loses
// supabase-js's literal-string column parsing and falls back to a
// GenericStringError result type (the same shape hits every other
// multi-column tenantDb() consumer — see src/lib/violations/worker.ts). Cast
// at this boundary rather than widening tenant-scoped.ts, which is out of
// scope for this feature.
type StripeCustomerRow = { data: { stripe_customer_id: string | null } | null; error: { message: string } | null };

/**
 * Create a Stripe Checkout session for a tenant to subscribe (or change) to
 * `planTier`. `client_reference_id` AND `subscription_data.metadata` both
 * carry the tenant id — the former is read on `checkout.session.completed`,
 * the latter is copied onto the Subscription object itself so every later
 * `customer.subscription.*` event is self-describing (see webhook-handler.ts)
 * without a second lookup.
 */
export async function createCheckoutSession(input: {
  tenantId: string;
  planTier: PlanTier;
  ownerEmail: string;
}): Promise<{ url: string }> {
  const plan = PLANS[input.planTier];
  const priceId = plan.stripePriceEnvVar ? process.env[plan.stripePriceEnvVar] : undefined;
  if (!priceId) {
    throw new MissingStripePriceError(
      `No Stripe price configured for plan "${input.planTier}" (expected env var ${plan.stripePriceEnvVar ?? '(none — contact-sales plan)'})`
    );
  }

  // Reuse an existing Stripe customer for this tenant if one already exists,
  // so upgrading/downgrading doesn't fragment a firm's billing history across
  // multiple Stripe customer records.
  const db = tenantDb(input.tenantId, 'checkout.createCheckoutSession');
  const { data: existing, error } = (await db
    .select('subscriptions', 'stripe_customer_id')
    .maybeSingle()) as StripeCustomerRow;
  if (error) throw error;

  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: existing?.stripe_customer_id ?? undefined,
    customer_email: existing?.stripe_customer_id ? undefined : input.ownerEmail,
    client_reference_id: input.tenantId,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: { tenant_id: input.tenantId, plan_tier: input.planTier },
    subscription_data: { metadata: { tenant_id: input.tenantId, plan_tier: input.planTier } },
    success_url: `${appUrl()}/settings?billing=success`,
    cancel_url: `${appUrl()}/settings?billing=cancelled`,
  });

  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return { url: session.url };
}

export class NoStripeCustomerError extends Error {}

/** Create a Stripe billing-portal session for a tenant that has already checked out at least once. */
export async function createPortalSession(tenantId: string): Promise<{ url: string }> {
  const db = tenantDb(tenantId, 'checkout.createPortalSession');
  const { data, error } = (await db
    .select('subscriptions', 'stripe_customer_id')
    .maybeSingle()) as StripeCustomerRow;
  if (error) throw error;
  if (!data?.stripe_customer_id) {
    throw new NoStripeCustomerError('This tenant has no Stripe customer yet — complete checkout first.');
  }

  const stripe = getStripeClient();
  const session = await stripe.billingPortal.sessions.create({
    customer: data.stripe_customer_id,
    return_url: `${appUrl()}/settings`,
  });

  return { url: session.url };
}
