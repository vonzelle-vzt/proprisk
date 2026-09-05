import type { PlatformTrade } from '@/types/platform';

export function analyzeTradesForViolations(trades: PlatformTrade[]): string[] {
  const violations = new Set<string>();
  if (trades.length === 0) return [];

  // HFT: trades with duration < 1 minute
  const hftTrades = trades.filter((t) => t.duration < 0.0167);
  if (hftTrades.length >= 5) violations.add('High Frequency Trading');

  // Martingale: increasing lot sizes after consecutive losses
  const sorted = [...trades].sort(
    (a, b) => new Date(a.closeTime).getTime() - new Date(b.closeTime).getTime()
  );
  let consecutive = 0;
  let prevLots = 0;
  for (const trade of sorted) {
    if (trade.profit < 0) {
      consecutive++;
      if (consecutive >= 2 && trade.lots > prevLots * 1.5 && prevLots > 0) {
        violations.add('Martingale');
        break;
      }
    } else {
      consecutive = 0;
    }
    prevLots = trade.lots;
  }

  // Over Leverage: unusually high lot sizes
  const avgLots = trades.reduce((s, t) => s + t.lots, 0) / trades.length;
  if (trades.filter((t) => t.lots > avgLots * 3).length >= 3) {
    violations.add('Over Leverage');
  }

  // Grid Trading: regular interval positions on same symbol
  const groups: Record<string, PlatformTrade[]> = {};
  trades.forEach((t) => {
    (groups[t.trdSymbol] ||= []).push(t);
  });
  for (const sym in groups) {
    const st = groups[sym];
    if (st.length < 5) continue;
    const prices = st.map((t) => t.openPrice).sort((a, b) => a - b);
    const intervals: number[] = [];
    for (let i = 1; i < prices.length; i++) intervals.push(prices[i] - prices[i - 1]);
    if (intervals.length >= 4) {
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const regular = intervals.filter((i) => Math.abs(i - avg) < avg * 0.2);
      if (regular.length >= intervals.length * 0.6) violations.add('Grid Trading');
    }
  }

  return Array.from(violations);
}
