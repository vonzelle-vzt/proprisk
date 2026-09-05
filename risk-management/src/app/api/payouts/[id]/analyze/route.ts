export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { fetchAccountDetails, fetchUserDetails } from '@/lib/platform/client';
import { runLocalViolationAnalysis } from '@/lib/payouts/local-analysis';
import { logError } from '@/lib/logging/logger';
import { DEMO_MODE, assetClassFromRequest } from '@/lib/demo';
import { buildAnalyzeResult } from '@/lib/mock/builders';
import { requireRiskUser } from '@/lib/auth/guards';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (DEMO_MODE) return Response.json(buildAnalyzeResult(assetClassFromRequest(req), id));

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  try {
    // Accept email and other fields from request body as fallbacks
    const body = await req.json().catch(() => ({}));

    const accountDetails = await fetchAccountDetails(id, auth.tenantId);
    const userId = accountDetails?.userId;
    const userDetails = userId ? await fetchUserDetails(userId, auth.tenantId) : null;

    // Use body email (from payout record) as primary, userDetails as fallback
    const email = body.email || userDetails?.email || '';

    const localResult = await runLocalViolationAnalysis({
      accountId: id,
      email,
      startingBalance: accountDetails?.startingBalance || 0,
      priorDayBalance: accountDetails?.priorDayBalance,
      priorDayEquity: accountDetails?.priorDayEquity,
      planName: accountDetails?.planName || '',
      tenantId: auth.tenantId,
    });

    // Build violation_details in same format as challenge cache
    const violation_details: Record<string, { trade_id: string; explanation: string; amount: number }[]> = {};
    for (const v of localResult.localAnalysis.violations) {
      if (v.deductionAmount <= 0) continue;
      if (!violation_details[v.typeKey]) violation_details[v.typeKey] = [];
      violation_details[v.typeKey].push({
        trade_id: v.trade.position || v.trade._id,
        explanation: v.explanation,
        amount: v.deductionAmount,
      });
    }

    // Build trades array matching challenge format
    const trades = localResult.trades.map((t) => ({
      _id: t._id,
      position: t.position,
      trdSymbol: t.trdSymbol,
      side: t.side,
      lots: t.lots,
      openTime: t.openTime,
      closeTime: t.closeTime,
      openPrice: t.openPrice,
      closePrice: t.closePrice,
      profit: t.profit,
      commission: t.commission || 0,
      swap: t.swap || 0,
      duration: t.duration,
    }));

    return Response.json({
      data: {
        violation_details,
        deduction_breakdown: localResult.mergedBreakdown,
        trades,
        news_events: localResult.localAnalysis.newsEvents || [],
        total_deductions: localResult.mergedTotal,
        violation_count: localResult.localAnalysis.summary.violatingTradeCount,
        flagged_trade_count: Object.values(localResult.localAnalysis.summary.violationTypeCount).reduce((s, c) => s + c, 0),
        trades_fetched: localResult.tradesFetched,
      },
    });
  } catch (err) {
    logError('Payout analysis failed', err, { route: '/api/payouts/[id]/analyze', category: 'external_api' });
    return Response.json({ error: 'Analysis failed' }, { status: 500 });
  }
}
