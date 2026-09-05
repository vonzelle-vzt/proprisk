export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import {
  fetchAccountMetrics,
  fetchAccountDetails,
  fetchUserDetails,
  fetchLedgerEvents,
  fetchAccountTradeData,
} from '@/lib/platform/client';
import { analyzeTradesDetailed } from '@/lib/payouts/detailed-risk-analysis';
import { matchNewsEventsForTrades, fetchEventsForDateRange } from '@/lib/news/calendar';
import { upsertNewsEvents, fetchNewsEventsFromDB } from '@/lib/news/db';
import { hasNewsAddon } from '@/lib/payouts/local-analysis';
import { logError } from '@/lib/logging/logger';
import { DEMO_MODE } from '@/lib/demo';
import { buildViolationDetail } from '@/lib/mock/builders';
import { requireRiskUser } from '@/lib/auth/guards';

const VIOLATION_TYPE_LABELS: Record<string, string> = {
  overleveraging: 'Overleveraging',
  hft: 'HFT',
  martingale: 'Martingale',
  news: 'News Trading',
  grid: 'Grid Trading',
  copy: 'Copy Trading',
  violations: 'Violations',
  overnight: 'Overnight',
};

export async function GET(
  _request: NextRequest,
  { params }: { params: { accountId: string } }
) {
  const { accountId } = params;

  if (DEMO_MODE) return Response.json(buildViolationDetail(accountId));

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  try {
    const [metrics, accountDetails, ledgerEvents] = await Promise.all([
      fetchAccountMetrics(accountId, auth.tenantId),
      fetchAccountDetails(accountId, auth.tenantId),
      fetchLedgerEvents(accountId, { limit: 200 }, auth.tenantId),
    ]);

    // Fetch user details if we have a userId
    const userId = accountDetails?.userId;
    const userDetails = userId ? await fetchUserDetails(userId, auth.tenantId) : null;

    const deductions = metrics.deductions;
    const na = (v: unknown) => (v == null || v === 'N/A' || v === 'n/a' || v === 'NA' || v === '') ? '' : String(v);
    const login = na(accountDetails?.login);
    const plan = na(accountDetails?.planName);
    const startingBalance = accountDetails?.startingBalance || 0;
    const email = na(userDetails?.email);

    // Build violation breakdown — filter out "N/A" type keys from the provider platform
    const violationBreakdown = deductions?.breakdownByType
      ? Object.entries(deductions.breakdownByType)
          .filter(([type, amount]) => amount > 0 && type !== 'N/A' && type !== 'n/a' && type !== 'NA' && type !== '')
          .map(([type, amount]) => ({
            type,
            label: VIOLATION_TYPE_LABELS[type] || type,
            amount,
            severity: amount > 500 ? 'critical' : amount > 200 ? 'high' : amount > 50 ? 'medium' : 'low',
          }))
      : [];

    // Filter ledger events for deductions and enrich generic/N/A notes
    const deductionEvents = ledgerEvents
      .filter(
        (e) =>
          e.event === 'cash_oper' &&
          (e.data?.note?.includes('Deduction') ||
            e.data?.note?.includes('Risk') ||
            (e.data?.amount && e.data.amount < 0))
      )
      .map((e) => {
        const rawNote = e.data?.note || '';
        const amount = e.data?.amount || 0;
        let note = rawNote;

        // Replace unhelpful notes with violation-specific descriptions
        if (!rawNote || rawNote.includes('N/A') || rawNote.length <= 5 || rawNote === 'Unknown') {
          // Match to closest violation type by amount
          const matchedViolation = violationBreakdown.find((v) => {
            const diff = Math.abs(Math.abs(amount) - v.amount);
            return diff < 1; // within $1
          });
          if (matchedViolation) {
            note = `${matchedViolation.label} violation — $${matchedViolation.amount.toFixed(2)} deducted from ${plan || 'account'} (${login})`;
          } else if (violationBreakdown.length > 0) {
            const types = violationBreakdown.map((v) => v.label).join(', ');
            note = `Risk deduction applied — violation type${violationBreakdown.length > 1 ? 's' : ''}: ${types} (${login})`;
          } else {
            note = `Risk deduction — $${Math.abs(amount).toFixed(2)} deducted from ${plan || 'account'} (${login})`;
          }
        }

        return {
          time: e.time,
          amount,
          note,
          balanceAfter: e.data?.balanceAfter || null,
        };
      });

    // Fetch trade data via foreign session (requires user email)
    let trades: any[] = [];
    let tradeTotal = 0;
    let tradeStats: any = null;

    if (email) {
      const tradeData = await fetchAccountTradeData(accountId, email, auth.tenantId);
      if (tradeData) {
        trades = tradeData.trades;
        tradeTotal = tradeData.tradeTotal;
        tradeStats = tradeData.stats;
      }
    }

    // If recheckNews is requested, fetch live news events and persist to DB
    const recheckNews = _request.nextUrl.searchParams.get('recheckNews') === 'true';
    let newsRechecked = false;
    if (recheckNews && trades.length > 0) {
      try {
        const tradeTimes = trades.map((t: any) => new Date(t.openTime).getTime());
        const minTime = Math.min(...tradeTimes);
        const maxTime = Math.max(...tradeTimes);
        const rangeStart = new Date(minTime);
        rangeStart.setUTCHours(0, 0, 0, 0);
        const rangeEnd = new Date(maxTime);
        rangeEnd.setUTCHours(23, 59, 59, 999);

        const liveEvents = await fetchEventsForDateRange(rangeStart, rangeEnd);
        if (liveEvents.length > 0) {
          await upsertNewsEvents(liveEvents);
          newsRechecked = true;
        }
      } catch {
        // Live fetch failed — continue with existing data
      }
    }

    // Fetch news events from DB for the trade date range (same as challenge accounts)
    let dbNewsEvents;
    const skipNews = hasNewsAddon(plan);
    if (!skipNews && trades.length > 0) {
      try {
        const tradeTimes = trades.map((t: any) => new Date(t.openTime).getTime());
        const minTime = Math.min(...tradeTimes);
        const maxTime = Math.max(...tradeTimes);
        const rangeStart = new Date(minTime);
        rangeStart.setUTCHours(0, 0, 0, 0);
        const rangeEnd = new Date(maxTime);
        rangeEnd.setUTCHours(23, 59, 59, 999);
        dbNewsEvents = await Promise.race([
          fetchNewsEventsFromDB(rangeStart, rangeEnd),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 10000)),
        ]);
      } catch {
        // News DB fetch failed — proceed without
      }
    }

    // Run detailed trade-level violation analysis
    // 2% cap uses min(starting day balance, starting day equity)
    const capBalance = accountDetails?.priorDayBalance || startingBalance;
    const capEquity = accountDetails?.priorDayEquity;
    const tradeAnalysis = analyzeTradesDetailed(trades, capBalance, capEquity, dbNewsEvents || undefined, startingBalance);

    // Batch-fetch news events for all news-flagged trades at once
    const newsTrades = tradeAnalysis.violations
      .filter((v) => v.typeKey === 'news')
      .map((v) => ({
        openTime: v.trade.openTime,
        symbol: v.trade.stdSymbol || v.trade.trdSymbol,
      }));

    const newsMatches = await matchNewsEventsForTrades(newsTrades);

    // Build flagged trades — drop news violations with no confirmed event
    const flaggedTrades: Array<Record<string, unknown>> = [];
    for (const v of tradeAnalysis.violations) {
      const symbol = v.trade.stdSymbol || v.trade.trdSymbol;
      let newsEvent: string | null = null;
      let newsCurrency: string | null = null;
      let newsImpact: string | null = null;
      let newsSource: string | null = null;
      let explanation = v.explanation;

      // Skip news violations for accounts with news addon
      if (v.typeKey === 'news' && skipNews) continue;

      if (v.typeKey === 'news') {
        const matchKey = `${v.trade.openTime}:${symbol}`;
        const match = newsMatches.get(matchKey);
        if (match) {
          newsEvent = match.event;
          newsCurrency = match.currency;
          newsImpact = match.impact;
          newsSource = match.source === 'forex_factory' ? 'Forex Factory' : 'FXStreet';
          explanation = `Trade opened during ${match.impact}-impact "${match.event}" (${match.currency}) — ${(v.trade.duration * 60).toFixed(0)}s duration, opened at ${new Date(v.trade.openTime).toISOString().substring(11, 16)} UTC. Source: ${newsSource}`;
        } else {
          // No real news event confirmed — skip this violation entirely
          continue;
        }
      }

      flaggedTrades.push({
        tradeId: v.trade._id,
        type: v.typeKey,
        typeLabel: v.type,
        explanation,
        deductionAmount: v.deductionAmount,
        symbol,
        side: v.trade.side,
        lots: v.trade.lots,
        openTime: v.trade.openTime,
        closeTime: v.trade.closeTime,
        openPrice: v.trade.openPrice,
        closePrice: v.trade.closePrice,
        duration: v.trade.duration,
        profit: v.trade.profit,
        commission: v.trade.commission,
        swap: v.trade.swap,
        stopLoss: v.trade.stopLoss,
        takeProfit: v.trade.takeProfit,
        newsEvent,
        newsCurrency,
        newsImpact,
        newsSource,
      });
    }

    // Recalculate summary after filtering out unconfirmed news violations
    const confirmedTypeCount: Record<string, number> = {};
    const confirmedTypeDeductions: Record<string, number> = {};
    const confirmedTradeIds = new Set<string>();
    const tradeMaxDeduction = new Map<string, number>();

    for (const ft of flaggedTrades) {
      const typeKey = ft.type as string;
      const tradeId = ft.tradeId as string;
      const amount = ft.deductionAmount as number;
      confirmedTypeCount[typeKey] = (confirmedTypeCount[typeKey] || 0) + 1;
      confirmedTypeDeductions[typeKey] = (confirmedTypeDeductions[typeKey] || 0) + amount;
      confirmedTradeIds.add(tradeId);
      tradeMaxDeduction.set(tradeId, Math.max(tradeMaxDeduction.get(tradeId) || 0, amount));
    }

    const confirmedTotalDeductions = Array.from(tradeMaxDeduction.values()).reduce((s, d) => s + d, 0);

    return Response.json({
      accountId,
      login,
      email,
      firstName: na(userDetails?.firstName),
      lastName: na(userDetails?.lastName),
      country: na(userDetails?.country),
      kycStatus:
        na(userDetails?.kycStatus) === 'COMPLETED'
          ? 'Verified'
          : na(userDetails?.kycStatus) || 'Unknown',
      isBlackListed: userDetails?.isBlackListed === 1,
      plan,
      startingBalance,
      balance: accountDetails?.lastBalance || 0,
      tradedDays: accountDetails?.tradedDays || 0,
      banNewsTrading: accountDetails?.banNewsTrading === 1,
      banHFT: accountDetails?.banHFT === 1,
      banMTGL: accountDetails?.banMTGL === 1,
      numApprovedPayouts: accountDetails?.numApprovedPayouts || 0,
      approvedPayouts: accountDetails?.approvedPayouts || 0,
      consistencyAtRequest: accountDetails?._curConsistencyPct || null,
      consistencyRequired: accountDetails?.consistencyPct || null,
      totalDeductions: deductions?.totalDeductions || 0,
      violationCount: deductions?.violationCount || 0,
      violationBreakdown,
      deductionEvents,
      accountMetrics: metrics.accountMetrics,
      // Trade data
      trades,
      tradeTotal,
      tradeStats,
      // Detailed trade-level violation analysis (news violations without confirmed events excluded)
      flaggedTrades,
      tradeAnalysisSummary: {
        totalDeductions: confirmedTotalDeductions,
        violationTypeCount: confirmedTypeCount,
        violatingTradeCount: confirmedTradeIds.size,
        deductionsByType: confirmedTypeDeductions,
      },
      newsRechecked,
    });
  } catch (err) {
    logError('Failed to fetch violation details', err, { route: '/api/platform/violations/[accountId]', category: 'external_api' });
    return Response.json(
      { error: 'Failed to fetch violation details' },
      { status: 500 }
    );
  }
}
