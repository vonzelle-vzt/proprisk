// Shared severity color/badge maps for the risk dashboard sections
// (severity distribution card, flagged-accounts table, all-payouts table).

export const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-400 border-red-500/30',
  high: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  medium: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  low: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
};

export const SEVERITY_BADGE: Record<string, 'red' | 'yellow' | 'blue' | 'silver'> = {
  critical: 'red', high: 'yellow', medium: 'blue', low: 'silver',
};
