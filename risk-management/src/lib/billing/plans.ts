/**
 * The pricing tiers. This is the single source of truth for plan shape —
 * entitlement enforcement (`entitlements.ts`) and the Stripe checkout route
 * both read from this table rather than each hardcoding their own copy, so a
 * price or ceiling never drifts between what a tenant is charged and what
 * they are entitled to.
 *
 * Nothing here applies unless BILLING_ENABLED=true (see ./config): the
 * default self-hosted deployment sells nothing, has no pricing page, and
 * takes the unlimited path in entitlements.ts without consulting this table
 * at all.
 *
 * Priced by funded accounts monitored (not seats, not trade volume) because
 * that is the number that drives our own cost to serve a firm — polling,
 * violation evaluation and evidence generation all scale with funded account
 * count, not headcount.
 */

export type PlanTier = 'starter' | 'growth' | 'scale' | 'enterprise';

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  /** USD/month. `null` = custom-quoted (enterprise). */
  priceMonthlyUsd: number | null;
  /** Funded-account ceiling this plan entitles a tenant to. `null` = unlimited. */
  maxAccounts: number | null;
  /** Stripe Price id env var this tier checks out against. `null` = no self-serve checkout. */
  stripePriceEnvVar: string | null;
  description: string;
  features: string[];
}

export const PLANS: Record<PlanTier, PlanDefinition> = {
  starter: {
    tier: 'starter',
    name: 'Starter',
    priceMonthlyUsd: 199,
    maxAccounts: 25,
    stripePriceEnvVar: 'STRIPE_PRICE_STARTER',
    description: 'For firms funding their first accounts.',
    features: [
      'Up to 25 funded accounts monitored',
      'Connect your own trading platform API',
      'Preset rule packs (Apex, TopStep, FTMO-style, and more)',
      'Shadow-mode backtest before you enforce',
      'Dispute-grade evidence packs',
    ],
  },
  growth: {
    tier: 'growth',
    name: 'Growth',
    priceMonthlyUsd: 499,
    maxAccounts: 100,
    stripePriceEnvVar: 'STRIPE_PRICE_GROWTH',
    description: 'For firms scaling past their first cohort of traders.',
    features: [
      'Up to 100 funded accounts monitored',
      'Everything in Starter',
      'Custom rule configuration',
      'Fraud & collusion network graph',
      'Liability forecasting',
    ],
  },
  scale: {
    tier: 'scale',
    name: 'Scale',
    priceMonthlyUsd: 1499,
    maxAccounts: 500,
    stripePriceEnvVar: 'STRIPE_PRICE_SCALE',
    description: 'For established firms running a full funded book.',
    features: [
      'Up to 500 funded accounts monitored',
      'Everything in Growth',
      'Priority support',
      'White-label branding',
    ],
  },
  enterprise: {
    tier: 'enterprise',
    name: 'Enterprise',
    priceMonthlyUsd: null,
    maxAccounts: null,
    stripePriceEnvVar: null,
    description: 'For firms beyond 500 funded accounts, or with custom compliance needs.',
    features: [
      'Unlimited funded accounts monitored',
      'Everything in Scale',
      'Dedicated onboarding',
      'Custom contractual SLAs',
    ],
  },
};

export const PLAN_ORDER: PlanTier[] = ['starter', 'growth', 'scale', 'enterprise'];

export function isPlanTier(value: string): value is PlanTier {
  return value in PLANS;
}

/** The account ceiling for a plan tier. Unknown tiers fail closed to 0, not unlimited. */
export function maxAccountsForTier(tier: string): number | null {
  if (!isPlanTier(tier)) return 0;
  return PLANS[tier].maxAccounts;
}
