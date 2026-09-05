import type Stripe from 'stripe';
import { isPlanTier, type PlanTier } from './plans';
import { tierForPriceId, upsertSubscription, findTenantIdByStripeCustomerId } from './subscriptions';

/**
 * Turns a *verified* Stripe event into a `subscriptions` row. Signature
 * verification happens in the route handler, before this function is ever
 * called — this module trusts its input completely, so it must never be
 * reachable except via a route that has already called
 * `stripe.webhooks.constructEvent()`.
 */

const STRIPE_STATUS_MAP: Record<string, string> = {
  incomplete: 'incomplete',
  incomplete_expired: 'canceled',
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  canceled: 'canceled',
  unpaid: 'unpaid',
  paused: 'past_due',
};

function mapStripeStatus(status: string): string {
  return STRIPE_STATUS_MAP[status] ?? 'incomplete';
}

function resolvePlanTierFromMetadata(metadata: Stripe.Metadata | null | undefined): PlanTier | null {
  const raw = metadata?.plan_tier;
  return raw && isPlanTier(raw) ? raw : null;
}

async function resolveTenantId(
  metadata: Stripe.Metadata | null | undefined,
  customerId: string
): Promise<string | null> {
  const fromMetadata = metadata?.tenant_id;
  if (fromMetadata) return fromMetadata;
  // Fallback for events whose object doesn't carry the metadata we stamped at
  // checkout (e.g. a subscription edited directly in the Stripe dashboard).
  return findTenantIdByStripeCustomerId(customerId);
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const tenantId = session.client_reference_id || session.metadata?.tenant_id || null;
  // Cannot attribute this session to a tenant — nothing safe to do with it.
  // This must never throw: an unattributable webhook is a data problem to
  // investigate out of band, not a reason to fail the HTTP response Stripe
  // is waiting on (a failure response makes Stripe retry the same event).
  if (!tenantId) return;

  const planTier = resolvePlanTierFromMetadata(session.metadata) ?? 'starter';
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  if (!customerId) return;

  const subscriptionId =
    typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null;

  await upsertSubscription({
    tenantId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    planTier,
    status: 'active',
    currentPeriodEnd: null,
  });
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  const customerId =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const tenantId = await resolveTenantId(subscription.metadata, customerId);
  if (!tenantId) return;

  const item = subscription.items.data[0];
  const planTier =
    tierForPriceId(item?.price?.id) ?? resolvePlanTierFromMetadata(subscription.metadata) ?? 'starter';
  const currentPeriodEnd = item?.current_period_end ? new Date(item.current_period_end * 1000) : null;

  await upsertSubscription({
    tenantId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    planTier,
    status: mapStripeStatus(subscription.status),
    currentPeriodEnd,
  });
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const customerId =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const tenantId = await resolveTenantId(subscription.metadata, customerId);
  if (!tenantId) return;

  const item = subscription.items.data[0];
  const planTier =
    tierForPriceId(item?.price?.id) ?? resolvePlanTierFromMetadata(subscription.metadata) ?? 'starter';

  // The cancellation itself only ever updates the billing row's status. See
  // entitlements.ts: a 'canceled' subscription still leaves every existing
  // funded account monitored — it just blocks onboarding new ones.
  await upsertSubscription({
    tenantId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    planTier,
    status: 'canceled',
    currentPeriodEnd: null,
  });
}

/** Dispatch one verified Stripe event. Unhandled event types are no-ops. */
export async function processStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      return;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
      return;
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
      return;
    default:
      return;
  }
}
