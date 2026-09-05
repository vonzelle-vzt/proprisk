import type { PlatformTrade } from '@/types/platform';
import type { TradeViolation, DetailedViolationResult } from '@/types/payouts';
import type { NewsEvent } from '@/lib/news/calendar';
import { extractCurrencies } from '@/lib/news/calendar';
import { LOT_LIMITS } from '@/config/violations';
import { classifyAsset } from '@/lib/utils/asset-class';
import type { AccountSize } from '@/types/database';

// Rolling window HFT thresholds
const HFT_THRESHOLDS = [
  { windowSeconds: 3,    maxTrades: 2,  label: '2 deals under 3 seconds' },
  { windowSeconds: 10,   maxTrades: 3,  label: '3 deals under 10 seconds' },
  { windowSeconds: 30,   maxTrades: 5,  label: '5 deals under 30 seconds' },
  { windowSeconds: 60,   maxTrades: 6,  label: '6 deals under 1 minute' },
  { windowSeconds: 3600, maxTrades: 30, label: '30 deals under 1 hour' },
];

function detectHFTViolations(trades: PlatformTrade[], out: TradeViolation[]) {
  if (trades.length < 2) return;

  // Deduplicate partial closes: group by position ID and keep only the first
  // entry per position. Partial closes share the same position ID but have
  // different _id/ticket values — they should count as one trade for HFT.
  const seenPositions = new Set<string>();
  const dedupedTrades: PlatformTrade[] = [];
  const partialsByPosition = new Map<string, PlatformTrade[]>();

  // First pass: group trades by position ID
  for (const trade of trades) {
    const posKey = trade.position || trade._id; // fallback to _id if no position
    if (!partialsByPosition.has(posKey)) {
      partialsByPosition.set(posKey, []);
    }
    partialsByPosition.get(posKey)!.push(trade);
  }

  // Second pass: pick one representative trade per position (earliest open)
  for (const [posKey, group] of partialsByPosition) {
    group.sort((a, b) => new Date(a.openTime).getTime() - new Date(b.openTime).getTime());
    dedupedTrades.push(group[0]);
  }

  if (dedupedTrades.length < 2) return;

  // Sort by open time for sliding window
  const sorted = dedupedTrades.sort(
    (a, b) => new Date(a.openTime).getTime() - new Date(b.openTime).getTime()
  );
  const openTimes = sorted.map((t) => new Date(t.openTime).getTime());

  // Track which positions have been flagged to avoid duplicates
  const flaggedPositions = new Set<string>();

  for (const threshold of HFT_THRESHOLDS) {
    const windowMs = threshold.windowSeconds * 1000;

    // Sliding window: for each trade, count unique positions within the window
    for (let i = 0; i < sorted.length; i++) {
      const windowStart = openTimes[i];
      const windowEnd = windowStart + windowMs;

      // Find all trades within this window
      let count = 0;
      const windowTrades: PlatformTrade[] = [];
      for (let j = i; j < sorted.length && openTimes[j] <= windowEnd; j++) {
        count++;
        windowTrades.push(sorted[j]);
      }

      if (count >= threshold.maxTrades) {
        // Flag all trades in this window that haven't been flagged yet
        // Also flag all partials belonging to flagged positions
        for (const trade of windowTrades) {
          const posKey = trade.position || trade._id;
          if (flaggedPositions.has(posKey)) continue;
          flaggedPositions.add(posKey);

          // Flag all partials for this position
          const allPartials = partialsByPosition.get(posKey) ?? [trade];
          for (const partial of allPartials) {
            out.push({
              type: 'High Frequency Trading',
              typeKey: 'hft',
              trade: partial,
              explanation: `${threshold.label}: ${count} positions opened within ${threshold.windowSeconds}s window`,
              deductionAmount: Math.max(0, partial.profit),
            });
          }
        }
        break; // Move to next threshold — this one already triggered
      }
    }
  }
}

function detectMartingaleViolations(trades: PlatformTrade[], out: TradeViolation[]) {
  const sorted = [...trades].sort(
    (a, b) => new Date(a.closeTime).getTime() - new Date(b.closeTime).getTime()
  );
  let consecutive = 0;
  let prevLots = 0;
  const flagged: PlatformTrade[] = [];

  for (const trade of sorted) {
    if (trade.profit < 0) {
      consecutive++;
      if (consecutive >= 2 && trade.lots > prevLots * 1.5 && prevLots > 0) {
        flagged.push(trade);
      }
    } else {
      consecutive = 0;
    }
    prevLots = trade.lots;
  }

  for (const trade of flagged) {
    out.push({
      type: 'Martingale',
      typeKey: 'martingale',
      trade,
      explanation: `Lot size ${trade.lots.toFixed(2)} increased >1.5x after consecutive losses`,
      deductionAmount: Math.max(0, trade.profit),
    });
  }
}

const ACCOUNT_SIZES: AccountSize[] = [2500, 5000, 10000, 25000, 50000, 100000, 200000, 300000];

function snapToAccountSize(balance: number): AccountSize {
  let best: AccountSize = ACCOUNT_SIZES[0];
  for (const size of ACCOUNT_SIZES) {
    if (size <= balance) best = size;
  }
  return best;
}

function detectOverLeverageViolations(trades: PlatformTrade[], out: TradeViolation[], accountSize?: number) {
  if (trades.length === 0) return;

  // If we have account size, use LOT_LIMITS config
  if (accountSize) {
    const snapped = snapToAccountSize(accountSize);
    const limits = LOT_LIMITS[snapped];
    if (!limits) return;

    // Group trades by symbol to check concurrent lot exposure
    const bySymbol: Record<string, PlatformTrade[]> = {};
    for (const t of trades) {
      (bySymbol[t.trdSymbol] ||= []).push(t);
    }

    const flagged = new Set<string>();

    for (const symbol in bySymbol) {
      const group = bySymbol[symbol];
      const assetClass = classifyAsset(symbol);
      const limit = limits[assetClass];
      if (limit === undefined) continue;

      for (const trade of group) {
        if (flagged.has(trade._id)) continue;

        // Sum lots of all trades on the same symbol that overlap in time
        const openMs = new Date(trade.openTime).getTime();
        const closeMs = new Date(trade.closeTime).getTime();
        let concurrentLots = 0;
        for (const other of group) {
          const otherOpen = new Date(other.openTime).getTime();
          const otherClose = new Date(other.closeTime).getTime();
          if (otherOpen < closeMs && otherClose > openMs) {
            concurrentLots += other.lots;
          }
        }

        if (concurrentLots > limit) {
          flagged.add(trade._id);
          const isSingle = concurrentLots === trade.lots;
          const explanation = isSingle
            ? `Lot size ${trade.lots.toFixed(2)} exceeds max allowed ${limit} lots for ${assetClass.replace('_', '/')} on $${snapped.toLocaleString()} account`
            : `Total concurrent lots ${concurrentLots.toFixed(2)} (this trade: ${trade.lots.toFixed(2)}) exceeds max allowed ${limit} lots for ${assetClass.replace('_', '/')} on $${snapped.toLocaleString()} account`;
          out.push({
            type: 'Over Leverage',
            typeKey: 'overleveraging',
            trade,
            explanation,
            deductionAmount: Math.max(0, trade.profit),
          });
        }
      }
    }
    return;
  }

  // Fallback: 3x average approach when account size is unknown
  const avgLots = trades.reduce((s, t) => s + t.lots, 0) / trades.length;
  const threshold = avgLots * 3;
  const overleveraged = trades.filter((t) => t.lots > threshold);
  if (overleveraged.length < 3) return;

  for (const trade of overleveraged) {
    out.push({
      type: 'Over Leverage',
      typeKey: 'overleveraging',
      trade,
      explanation: `Lot size ${trade.lots.toFixed(2)} exceeds max allowed ${threshold.toFixed(2)} (3× avg of ${avgLots.toFixed(2)})`,
      deductionAmount: Math.max(0, trade.profit),
    });
  }
}

function detectGridViolations(trades: PlatformTrade[], out: TradeViolation[]) {
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
    if (intervals.length < 4) continue;

    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const regular = intervals.filter((i) => Math.abs(i - avg) < avg * 0.2);
    if (regular.length < intervals.length * 0.6) continue;

    for (const trade of st) {
      out.push({
        type: 'Grid Trading',
        typeKey: 'grid',
        trade,
        explanation: `Regular price intervals detected on ${sym} (${st.length} trades, ${(regular.length / intervals.length * 100).toFixed(0)}% regular)`,
        deductionAmount: Math.max(0, trade.profit),
      });
    }
  }
}

const COUNTRY_TO_CURRENCY: Record<string, string> = {
  US: 'USD', EU: 'EUR', GB: 'GBP', JP: 'JPY',
  AU: 'AUD', CA: 'CAD', NZ: 'NZD', CH: 'CHF',
};

function detectNewsViolations(trades: PlatformTrade[], out: TradeViolation[], newsEvents?: NewsEvent[]) {
  if (!newsEvents || newsEvents.length === 0) return;

  // Only high-impact (red) events
  const highImpactEvents = newsEvents.filter(
    (e) => e.impact === 'High' || e.impact === 'high' || e.impact === 'RED' || e.impact === 'red'
  );
  if (highImpactEvents.length === 0) return;

  const WINDOW_MS = 5 * 60 * 1000; // 5 minutes

  for (const trade of trades) {
    const tradeCurrencies = extractCurrencies(trade.trdSymbol);
    const openMs = new Date(trade.openTime).getTime();
    const closeMs = new Date(trade.closeTime).getTime();

    for (const evt of highImpactEvents) {
      // Currency must match the traded instrument (evt.country is 2-letter code like "US", convert to currency "USD")
      const evtCurrency = COUNTRY_TO_CURRENCY[evt.country.toUpperCase()] || evt.country.toUpperCase();
      if (tradeCurrencies.length > 0 && !tradeCurrencies.includes(evtCurrency)) continue;

      const evtMs = new Date(evt.date).getTime();
      const openDiff = Math.abs(openMs - evtMs);
      const closeDiff = Math.abs(closeMs - evtMs);
      const openInWindow = openDiff <= WINDOW_MS;
      const closeInWindow = closeDiff <= WINDOW_MS;

      if (openInWindow || closeInWindow) {
        const action = openInWindow ? 'opened' : 'closed';
        const diffMin = ((openInWindow ? openDiff : closeDiff) / 60000).toFixed(1);
        out.push({
          type: 'News Trading',
          typeKey: 'news',
          trade,
          explanation: `Trade ${action} ${diffMin}min from "${evt.title}" (${evt.country}, ${evt.impact}) at ${evt.date.substring(11, 16)} UTC`,
          deductionAmount: Math.max(0, trade.profit),
        });
        break; // One match per trade is enough
      }
    }
  }
}

export function analyzeTradesDetailed(
  trades: PlatformTrade[],
  startDayBalance?: number,
  startDayEquity?: number,
  newsEvents?: NewsEvent[],
  accountSize?: number
): DetailedViolationResult {
  const violations: TradeViolation[] = [];
  if (trades.length === 0) return { violations: [], summary: { totalDeductions: 0, violationTypeCount: {}, violatingTradeCount: 0, deductionsByType: {} }, newsEvents: [] };

  detectHFTViolations(trades, violations);
  detectMartingaleViolations(trades, violations);
  detectOverLeverageViolations(trades, violations, accountSize);
  detectGridViolations(trades, violations);
  detectNewsViolations(trades, violations, newsEvents);

  // Deduplicate: same trade+typeKey should only appear once
  const seen = new Set<string>();
  const deduped = violations.filter((v) => {
    const key = `${v.trade._id}:${v.typeKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const typeCount: Record<string, number> = {};
  const tradeIds = new Set<string>();
  const typeDeductions: Record<string, number> = {};
  for (const v of deduped) {
    typeCount[v.typeKey] = (typeCount[v.typeKey] || 0) + 1;
    typeDeductions[v.typeKey] = (typeDeductions[v.typeKey] || 0) + v.deductionAmount;
    tradeIds.add(v.trade._id);
  }

  // Calculate total deductions per unique trade (avoid double-counting
  // the same trade flagged by multiple violation types)
  const tradeMaxDeduction = new Map<string, number>();
  for (const v of deduped) {
    const existing = tradeMaxDeduction.get(v.trade._id) || 0;
    tradeMaxDeduction.set(v.trade._id, Math.max(existing, v.deductionAmount));
  }
  const totalDeductions = Array.from(tradeMaxDeduction.values()).reduce((s, d) => s + d, 0);

  // Filter high-impact news events to return with the result
  const highImpactNews = (newsEvents || [])
    .filter((e) => e.impact === 'High' || e.impact === 'high' || e.impact === 'RED' || e.impact === 'red')
    .map((e) => ({ title: e.title, country: e.country, date: e.date, impact: e.impact, source: e.source }));

  return {
    violations: deduped,
    summary: {
      totalDeductions,
      violationTypeCount: typeCount,
      violatingTradeCount: tradeIds.size,
      deductionsByType: typeDeductions,
    },
    newsEvents: highImpactNews,
  };
}
