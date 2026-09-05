export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { fetchAccountDetails, fetchUserDetails, fetchLedgerEvents } from '@/lib/platform/client';
import { runLocalViolationAnalysis } from '@/lib/payouts/local-analysis';
import { logError } from '@/lib/logging/logger';
import { DEMO_MODE } from '@/lib/demo';
import { requireRiskUser } from '@/lib/auth/guards';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (DEMO_MODE) {
    return Response.json({
      data: { details: `Demo risk check for account ${id}: no outstanding ledger discrepancies; consistency within limits.` },
    });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  try {
    const [accountDetails, ledgerEvents] = await Promise.all([
      fetchAccountDetails(id, auth.tenantId),
      fetchLedgerEvents(id, { limit: 50 }, auth.tenantId),
    ]);

    // Get email from account details or user details
    const userId = accountDetails?.userId;
    const userDetails = userId ? await fetchUserDetails(userId, auth.tenantId) : null;
    const email = userDetails?.email || '';

    // Run local violation analysis — same engine as challenges
    const localResult = await runLocalViolationAnalysis({
      accountId: id,
      email,
      startingBalance: accountDetails?.startingBalance || 0,
      priorDayBalance: accountDetails?.priorDayBalance,
      priorDayEquity: accountDetails?.priorDayEquity,
      planName: accountDetails?.planName || '',
      tenantId: auth.tenantId,
    });

    const deductionEvents = ledgerEvents.filter(
      (e) => e.event === 'cash_oper' && e.data?.note?.includes('Risk Deduction')
    );

    const violationTypes = Object.keys(localResult.mergedBreakdown);
    const totalDeductions = localResult.mergedTotal;
    const violationCount = localResult.localAnalysis.summary.violatingTradeCount;

    return Response.json({
      data: {
        accountId: id,
        violations: violationTypes.map((type) => ({
          type,
          amount: localResult.mergedBreakdown[type] || 0,
        })),
        summary: {
          totalDeductions,
          violationTypeCount: localResult.mergedBreakdown,
          violatingTradeCount: violationCount,
        },
        tradeCount: localResult.trades.length,
        trades: [],
        deductions: totalDeductions > 0
          ? {
              totalDeductions,
              breakdownByType: localResult.mergedBreakdown,
              violationCount,
            }
          : null,
        accountMetrics: {
          planName: accountDetails?.planName,
          startingBalance: accountDetails?.startingBalance,
          tradedDays: accountDetails?.tradedDays,
          maxDailyProfit: accountDetails?.maxDailyProfit,
          banNewsTrading: accountDetails?.banNewsTrading,
          banHFT: accountDetails?.banHFT,
          banMTGL: accountDetails?.banMTGL,
        },
        deductionEvents: deductionEvents.map((e) => ({
          time: e.time,
          amount: e.data?.amount || e.data?._postedAmount || 0,
          note: e.data?.note || '',
        })),
        details: totalDeductions > 0
          ? `Found ${violationCount} violation(s) totaling $${totalDeductions.toFixed(2)}. Types: ${violationTypes.join(', ')}`
          : `No violations found for account ${id}.`,
      },
    });
  } catch (err) {
    logError('Risk check failed', err, { route: '/api/payouts/[id]/risk-check', category: 'external_api' });
    return Response.json({ error: 'Risk check failed' }, { status: 500 });
  }
}
