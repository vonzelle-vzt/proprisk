/**
 * Canonical violation label + badge-variant map.
 *
 * Previously duplicated verbatim in `src/components/challenges/send-violation-email-modal.tsx`
 * and `src/components/payouts/send-payout-email-modal.tsx` (identical `VIOLATION_LABELS`
 * objects, both including `overnight`, which `src/lib/providers/types.ts`'s
 * `VIOLATION_LABELS` does not), plus a separate `violationBadgeVariant` map in
 * `src/components/enforcement/enforcement-detail-modal.tsx` (missing an
 * `overleveraging` entry, silently falling back to `silver`).
 *
 * This module is the single source of truth going forward — it is a superset
 * of `src/lib/providers/types.ts`'s `VIOLATION_LABELS` (forex + futures) plus
 * the extra keys the modals had (`overnight`) and the catch-all key routes
 * use (`violations`, `profit_cap` alias for `2_percent_cap`).
 *
 * NOTE: per the build brief, the duplicated maps in the consumer components
 * above are intentionally left untouched here — a later mechanic pass swaps
 * them over to import from this module.
 */

export const VIOLATION_LABELS: Record<string, string> = {
  // forex
  overleveraging: 'Overleveraging',
  hft: 'HFT',
  martingale: 'Martingale',
  news: 'News Trading',
  grid: 'Grid Trading',
  copy: 'Copy Trading',
  overnight: 'Overnight',
  profit_cap: '2% Profit Cap',
  '2_percent_cap': '2% Profit Cap',
  violations: 'Violations',
  // futures
  daily_loss: 'Daily Loss Limit',
  trailing_drawdown: 'Trailing Drawdown',
  position_limit: 'Position Limit',
  eod_flat: 'End-of-Day Flat',
};

export type ViolationBadgeVariant = 'purple' | 'red' | 'yellow' | 'blue' | 'green' | 'silver';

const BADGE_VARIANTS: Record<string, ViolationBadgeVariant> = {
  overleveraging: 'green',
  copy: 'purple',
  martingale: 'red',
  grid: 'yellow',
  hft: 'blue',
  news: 'green',
  overnight: 'silver',
  daily_loss: 'red',
  trailing_drawdown: 'yellow',
  position_limit: 'blue',
  eod_flat: 'silver',
};

/** Human label for a violation typeKey, falling back to the raw key. */
export function violationLabel(typeKey: string): string {
  return VIOLATION_LABELS[typeKey] || typeKey;
}

/** Badge color variant for a violation typeKey, falling back to 'silver'. */
export function violationBadgeVariant(typeKey: string): ViolationBadgeVariant {
  return BADGE_VARIANTS[typeKey] ?? 'silver';
}
