import { GlassCard } from '@/components/ui/glass-card';

interface Feature {
  title: string;
  body: string;
}

// The differentiators, in the order prospects actually ask about them:
// price transparency first (it's the headline claim), then the two things
// that make switching low-risk (bring your own platform, prove it in shadow
// mode before enforcing), then what a firm cares about after they're live
// (evidence for disputes, isolation from every other firm on the platform).
const FEATURES: Feature[] = [
  {
    title: 'Published pricing',
    body:
      'No sales call required to find out what this costs. Every tier below has a real number on it, priced by the one thing that actually drives our cost to serve you: funded accounts monitored.',
  },
  {
    title: 'Bring your own platform',
    body:
      'Connect MatchTrader, Tradovate, DXtrade, TradeLocker, cTrader, MT4/5, Rithmic, TopstepX, CQG or NinjaTrader through your own API credentials. We read your accounts and trades; we never take custody of anything.',
  },
  {
    title: 'Configure your own rules',
    body:
      'Start from a preset modelled on Apex, TopStep, Tradeify, Lucid, FTMO, FundedNext or The5ers, or write your own. The rule engine is the same one enforcing rules for every other firm on the platform — you just point it at your numbers.',
  },
  {
    title: 'Shadow-mode backtest first',
    body:
      'Before a single enforcement action fires against a real account, run the new rule pack against your existing platform’s historical decisions in shadow mode and see exactly where it agrees and disagrees. Enforce only once you trust it.',
  },
  {
    title: 'Dispute-grade evidence packs',
    body:
      'Every payout decision generates an evidence pack a trader — or their lawyer — can be handed: the rule that fired, the trade data behind it, and the exact reasoning, not a one-line "policy violation."',
  },
  {
    title: 'Your data, isolated',
    body:
      'Every table in this product carries a tenant boundary enforced at the database layer, not just in application code. No prop firm on this platform can query another firm’s accounts, trades, or evidence — by construction, not by promise.',
  },
];

export function MarketingFeatureGrid() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16">
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature) => (
          <GlassCard key={feature.title} padding="lg">
            <h3 className="mb-2 text-lg font-bold text-white">{feature.title}</h3>
            <p className="text-sm text-gray-300">{feature.body}</p>
          </GlassCard>
        ))}
      </div>
    </section>
  );
}
