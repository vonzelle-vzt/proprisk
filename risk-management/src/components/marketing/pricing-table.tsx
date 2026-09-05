import Link from 'next/link';
import { GlassCard } from '@/components/ui/glass-card';
import { PLANS, PLAN_ORDER } from '@/lib/billing/plans';

/**
 * Reads tier definitions from src/lib/billing/plans.ts — the same table
 * entitlement enforcement and the Stripe checkout route read from — so the
 * price and account ceiling shown here can never drift from what a
 * subscribing firm is actually charged and entitled to.
 */
export function MarketingPricingTable() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16">
      <div className="mb-10 text-center">
        <h2 className="text-3xl font-bold text-white">Pricing</h2>
        <p className="mt-3 text-gray-400">Priced by funded accounts monitored. No sales call required.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-4">
        {PLAN_ORDER.map((tier) => {
          const plan = PLANS[tier];
          const highlighted = tier === 'growth';
          return (
            <GlassCard key={tier} padding="lg" glow={highlighted ? 'red' : 'none'}>
              <h3 className="text-lg font-bold text-white">{plan.name}</h3>
              <p className="mt-1 text-sm text-gray-400">{plan.description}</p>
              <p className="mt-6 text-3xl font-bold text-white">
                {plan.priceMonthlyUsd !== null ? (
                  <>
                    ${plan.priceMonthlyUsd.toLocaleString()}
                    <span className="text-base font-normal text-gray-500">/mo</span>
                  </>
                ) : (
                  'Custom'
                )}
              </p>
              <p className="mt-1 text-sm text-gray-500">
                {plan.maxAccounts !== null
                  ? `Up to ${plan.maxAccounts.toLocaleString()} funded accounts monitored`
                  : 'Unlimited funded accounts monitored'}
              </p>
              <ul className="mt-6 space-y-2 text-sm text-gray-300">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <span className="text-red-500">–</span>
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className={
                  highlighted
                    ? 'mt-8 block rounded-xl border border-red-500/50 bg-red-600 px-4 py-2.5 text-center text-sm font-medium text-white shadow-lg shadow-red-500/20 hover:bg-red-700'
                    : 'mt-8 block rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-center text-sm font-medium text-gray-200 hover:bg-white/20'
                }
              >
                {tier === 'enterprise' ? 'Contact sales' : 'Start free'}
              </Link>
            </GlassCard>
          );
        })}
      </div>
    </section>
  );
}
