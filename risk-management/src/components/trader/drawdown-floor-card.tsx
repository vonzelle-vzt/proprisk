import { GlassCard } from '@/components/ui/glass-card';
import { Badge } from '@/components/ui/badge';
import type { HeadroomItem } from '@/lib/trader/headroom';

/**
 * The drawdown floor gets its own, larger card — per docs/HOW-IT-WORKS.md
 * §6.1, this is "the number that decides their account" and the rationale
 * for this entire feature ("a trader who watched the floor move all week
 * does not file a chargeback when it is hit").
 */
export function DrawdownFloorCard({ item }: { item: HeadroomItem }) {
  if (!item.drawdown) return null;
  const { floor, locked } = item.drawdown;

  return (
    <GlassCard padding="lg" glow={item.status === 'breached' ? 'red' : 'silver'}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm uppercase tracking-wider text-gray-400">Your drawdown floor</p>
        {locked && <Badge variant="silver">Locked</Badge>}
      </div>
      <p className="mt-2 text-3xl font-bold text-white">
        ${floor.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </p>
      <p className="mt-2 text-base text-gray-300">
        {locked
          ? 'This floor has locked and will not move again — your account can never be stopped out below it.'
          : 'Stay above this line. It moves up as your account makes new highs.'}
      </p>
      {item.headroom && <p className="mt-3 text-base text-gray-400">{item.headroom}</p>}
    </GlassCard>
  );
}
