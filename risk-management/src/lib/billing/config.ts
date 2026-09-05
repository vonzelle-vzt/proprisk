/**
 * Billing kill switch.
 *
 * This product ships as a self-hosted console a firm runs for its own risk
 * team — there is no storefront and no subscription to sell them. Stripe is
 * therefore OFF unless a deployment explicitly opts in with
 * `BILLING_ENABLED=true`, and off means off at the edges of the feature:
 *
 *   - the three /api/billing routes (checkout, portal, webhook) 404 before
 *     doing any work
 *   - entitlement checks stop applying a plan ceiling
 *     (src/lib/billing/entitlements.ts)
 *
 * Opt-in rather than opt-out on purpose: a missing env var must fail towards
 * "this deployment does not bill", never towards a half-configured Stripe
 * integration that a firm's own instance suddenly tries to charge against.
 *
 * Read once at module load, like every other boolean env flag in this repo
 * (see DEMO_MODE in src/lib/demo). The Stripe env vars this gates are
 * declared in src/lib/env/validate.ts, which requires them only when this is
 * true.
 */
export const BILLING_ENABLED = process.env.BILLING_ENABLED === 'true';

/**
 * The single response every billing route gives when the flag is off. A 404
 * rather than a 403: on a deployment that does not bill, these endpoints do
 * not exist, and saying so leaks nothing about whether billing could be
 * turned on.
 */
export const BILLING_DISABLED_MESSAGE = 'Billing is not enabled on this deployment';
