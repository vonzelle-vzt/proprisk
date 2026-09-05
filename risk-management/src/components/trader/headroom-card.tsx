import { GlassCard } from '@/components/ui/glass-card';
import { Badge } from '@/components/ui/badge';
import type { HeadroomItem } from '@/lib/trader/headroom';

/**
 * One rule, read the way a trader needs it: what the limit is, where they
 * stand, and how much room is left — never a raw number without its meaning.
 *
 * Deliberately calmer than the operator terminal's dense StatCard: this is
 * read by one person on a phone, not scanned across a book of accounts.
 * DESIGN.md documents no trader-facing surface (see the report for this
 * feature); this borrows the marketing surface's larger type scale as the
 * only prior art in this repo for a non-operator audience, rather than the
 * terminal's 10-11px density.
 */
export function HeadroomCard({ item }: { item: HeadroomItem }) {
  const badge =
    item.status === 'breached'
      ? { variant: 'red' as const, label: 'Breached' }
      : { variant: 'green' as const, label: 'On track' };

  return (
    <GlassCard padding="md" glow={item.status === 'breached' ? 'red' : 'none'}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-gray-400">{item.limit}</p>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>
      <p className="mt-2 text-lg font-semibold text-white">{item.position}</p>
      {item.headroom && <p className="mt-1 text-base text-gray-300">{item.headroom}</p>}
    </GlassCard>
  );
}
