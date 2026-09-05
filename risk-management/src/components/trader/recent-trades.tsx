import { GlassCard } from '@/components/ui/glass-card';
import type { TraderClosedTrade } from '@/lib/trader/data';

/**
 * Closed trades only. Open positions, deduction amounts owed to the firm and
 * anything internal (fraud flags, notes) are never fetched for this surface
 * in the first place — see src/lib/trader/data.ts — so there is nothing to
 * accidentally render here.
 */
export function RecentTrades({ trades }: { trades: TraderClosedTrade[] }) {
  if (trades.length === 0) {
    return (
      <GlassCard padding="md">
        <p className="text-base text-gray-400">No closed trades yet.</p>
      </GlassCard>
    );
  }

  return (
    <GlassCard padding="md">
      <p className="text-sm uppercase tracking-wider text-gray-400 mb-3">Recent closed trades</p>
      <div className="flex flex-col divide-y divide-white/10">
        {trades.map((trade) => (
          <div key={trade.id} className="flex items-center justify-between py-2 gap-3">
            <div>
              <p className="text-base text-white">{trade.symbol}</p>
              <p className="text-sm text-gray-500">
                {new Date(trade.closeTime).toLocaleString()}
              </p>
            </div>
            <p
              className={
                trade.profit >= 0 ? 'text-base font-semibold text-emerald-400' : 'text-base font-semibold text-red-400'
              }
            >
              {trade.profit >= 0 ? '+' : ''}
              {trade.profit.toFixed(2)}
            </p>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}
