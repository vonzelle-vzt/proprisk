import Stripe from 'stripe';

/**
 * Lazy Stripe client. Constructed on first use rather than at module load so
 * importing this file (e.g. transitively, from a test) never throws for a
 * missing env var — only actually calling the Stripe API does.
 */
let cached: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (cached) return cached;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Billing routes cannot create checkout/portal sessions without it.'
    );
  }

  cached = new Stripe(key, {
    // Pinned so a Stripe account-level API version change cannot silently
    // change this app's webhook payload shape underneath it.
    apiVersion: '2026-07-29.dahlia',
  });
  return cached;
}
