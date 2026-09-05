import { fetchAccountTradeData } from '@/lib/platform/client';
import { analyzeTradesDetailed } from '@/lib/payouts/detailed-risk-analysis';
import { fetchNewsEventsFromDB } from '@/lib/news/db';
import { matchNewsEventsForTrades } from '@/lib/news/calendar';
import type { PlatformTrade } from '@/types/platform';
import type { DetailedViolationResult } from '@/types/payouts';

/** Check if plan name has the News Trading addon */
export function hasNewsAddon(planName: string): boolean {
  return planName.toUpperCase().includes(',NT') || planName.toUpperCase().endsWith('NT');
}

export interface LocalAnalysisInput {
  accountId: string;
  email: string;
  startingBalance: number;
  priorDayBalance?: number;
  priorDayEquity?: number;
  planName: string;
  /** Threaded to fetchAccountTradeData so the right tenant's provider connection is used. */
  tenantId: string;
}

export interface LocalAnalysisResult {
  localAnalysis: DetailedViolationResult;
  mergedBreakdown: Record<string, number>;
  mergedTotal: number;
  mergedViolationTypes: string[];
  trades: PlatformTrade[];
  tradesFetched: boolean;
}

const EMPTY_ANALYSIS: DetailedViolationResult = {
  violations: [],
  summary: { totalDeductions: 0, violationTypeCount: {}, violatingTradeCount: 0, deductionsByType: {} },
  newsEvents: [],
};

/**
 * Run local violation analysis on a funded payout account.
 * Uses the same analyzeTradesDetailed() engine as challenge accounts
 * for ALL violation types: HFT, martingale, overleveraging, grid, news.
 *
 * Returns empty violations if trades cannot be fetched.
 */
export async function runLocalViolationAnalysis(
  input: LocalAnalysisInput,
): Promise<LocalAnalysisResult> {
  const { accountId, email, startingBalance, priorDayBalance, priorDayEquity, planName, tenantId } = input;

  // No email → can't fetch trades → no violation data
  if (!email) {
    return buildFallbackResult();
  }

  // Fetch trade data with timeout
  let tradeData: Awaited<ReturnType<typeof fetchAccountTradeData>> | null = null;
  try {
    tradeData = await Promise.race([
      fetchAccountTradeData(accountId, email, tenantId),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error('trade fetch timeout')), 30000)),
    ]);
  } catch {
    // Trade fetch failed → no violation data
    return buildFallbackResult();
  }

  if (!tradeData || tradeData.trades.length === 0) {
    return buildFallbackResult();
  }

  const trades = tradeData.trades;
  const skipNews = hasNewsAddon(planName);

  // Fetch news events from DB for the trade date range
  let newsEvents;
  if (!skipNews) {
    try {
      const tradeTimes = trades.map((t) => new Date(t.openTime).getTime());
      const minTime = Math.min(...tradeTimes);
      const maxTime = Math.max(...tradeTimes);
      const rangeStart = new Date(minTime);
      rangeStart.setUTCHours(0, 0, 0, 0);
      const rangeEnd = new Date(maxTime);
      rangeEnd.setUTCHours(23, 59, 59, 999);
      newsEvents = await Promise.race([
        fetchNewsEventsFromDB(rangeStart, rangeEnd),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 10000)),
      ]);
    } catch {
      // News fetch failed → proceed without news events
    }
  }

  // Run the same analysis engine used by challenge accounts
  const localAnalysis = analyzeTradesDetailed(
    trades,
    priorDayBalance || startingBalance,
    priorDayEquity,
    newsEvents || undefined,
    startingBalance,
  );

  // For news violations: verify against real events, drop unverified
  const newsTrades = localAnalysis.violations
    .filter((v) => v.typeKey === 'news')
    .map((v) => ({ openTime: v.trade.openTime, symbol: v.trade.stdSymbol || v.trade.trdSymbol }));

  let newsMatches = new Map<string, { event: string; currency: string; impact: string; source: string }>();
  if (newsTrades.length > 0) {
    try {
      newsMatches = await matchNewsEventsForTrades(newsTrades);
    } catch {
      // Verification failed → news violations won't be counted
    }
  }

  // Build deduction amounts for ALL violation types from local analysis
  const deductionsByType: Record<string, number> = {};
  for (const v of localAnalysis.violations) {
    // Skip news violations for accounts with news addon
    if (v.typeKey === 'news' && skipNews) continue;

    // For news: only count if verified against real events
    if (v.typeKey === 'news') {
      const matchKey = `${v.trade.openTime}:${v.trade.stdSymbol || v.trade.trdSymbol}`;
      if (!newsMatches.has(matchKey)) continue;
    }

    deductionsByType[v.typeKey] = (deductionsByType[v.typeKey] || 0) + v.deductionAmount;
  }

  // Filter out zero-amount types
  const mergedBreakdown: Record<string, number> = {};
  for (const [type, amount] of Object.entries(deductionsByType)) {
    if (amount > 0) mergedBreakdown[type] = amount;
  }

  const mergedTotal = Object.values(mergedBreakdown).reduce((s, a) => s + a, 0);
  const mergedViolationTypes = Object.keys(mergedBreakdown);

  return {
    localAnalysis,
    mergedBreakdown,
    mergedTotal,
    mergedViolationTypes,
    trades,
    tradesFetched: true,
  };
}

/** Fallback when trades can't be fetched — return empty violations */
function buildFallbackResult(): LocalAnalysisResult {
  return {
    localAnalysis: EMPTY_ANALYSIS,
    mergedBreakdown: {},
    mergedTotal: 0,
    mergedViolationTypes: [],
    trades: [],
    tradesFetched: false,
  };
}
