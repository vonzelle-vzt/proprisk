export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import {
  fetchPendingPayouts,
  fetchAccountDetails,
  fetchUserDetails,
} from '@/lib/platform/client';
import { runLocalViolationAnalysis } from '@/lib/payouts/local-analysis';
import type { PlatformPayout } from '@/types/platform';
import { logError } from '@/lib/logging/logger';
import { DEMO_MODE, assetClassFromRequest } from '@/lib/demo';
import { buildDeductionsSummary } from '@/lib/mock/builders';
import { requireRiskUser } from '@/lib/auth/guards';

const CONCURRENCY = 5;

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

export async function GET(_request: NextRequest) {
  if (DEMO_MODE) return Response.json(buildDeductionsSummary(assetClassFromRequest(_request)));

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  try {
    // Fetch ALL pending payouts — no date-field to ensure nothing is excluded
    const payouts = await fetchPendingPayouts({
      statuses: ['Pending'],
      limit: 1000,
    }, auth.tenantId);

    // Deduplicate by accountId
    const uniqueAccounts = new Map<string, PlatformPayout>();
    for (const p of payouts) {
      if (p.status?.toLowerCase() === 'pending' && p.accountId && !uniqueAccounts.has(p.accountId)) {
        uniqueAccounts.set(p.accountId, p);
      }
    }

    const accounts = Array.from(uniqueAccounts.values());
    const allDeductions: { violationType: string; amount: number }[] = [];
    const detailList: { login: string; accountId: string; plan: string; violationType: string; violationLabel: string; amount: number }[] = [];

    for (let i = 0; i < accounts.length; i += CONCURRENCY) {
      const batch = accounts.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (payout) => {
          const accountId = payout.accountId.toString();
          const [accountDetails, userDetails] = await Promise.all([
            fetchAccountDetails(accountId, auth.tenantId),
            payout.userId ? fetchUserDetails(payout.userId, auth.tenantId) : Promise.resolve(null),
          ]);

          const email = payout.email || userDetails?.email || '';

          // Run local violation analysis — same logic as challenges, all types
          const localResult = await runLocalViolationAnalysis({
            accountId,
            email,
            startingBalance: accountDetails?.startingBalance || 0,
            priorDayBalance: accountDetails?.priorDayBalance,
            priorDayEquity: accountDetails?.priorDayEquity,
            planName: accountDetails?.planName || payout.plan || '',
            tenantId: auth.tenantId,
          });

          return { payout, localResult };
        })
      );

      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const { payout, localResult } = r.value;

        if (localResult.mergedTotal <= 0) continue;

        const na = (v: unknown) => (v == null || v === 'N/A' || v === 'n/a' || v === 'NA' || v === '') ? '' : String(v);
        const login = na(payout.login);
        const accountId = na(payout.accountId);
        const plan = na(payout.plan);

        for (const [type, amount] of Object.entries(localResult.mergedBreakdown)) {
          if (amount <= 0) continue;
          const violationLabel = VIOLATION_TYPE_LABELS[type] || type;

          allDeductions.push({ violationType: type, amount });
          detailList.push({ login, accountId, plan, violationType: type, violationLabel, amount });
        }
      }
    }

    // Breakdown by type
    const byType = new Map<string, { count: number; total_amount: number }>();
    for (const d of allDeductions) {
      const existing = byType.get(d.violationType) || { count: 0, total_amount: 0 };
      existing.count++;
      existing.total_amount += d.amount;
      byType.set(d.violationType, existing);
    }

    const by_violation_type = Array.from(byType.entries()).map(([type, stats]) => ({
      type: VIOLATION_TYPE_LABELS[type] || type,
      count: stats.count,
      total_amount: stats.total_amount,
    }));

    const totalAmount = allDeductions.reduce((sum, d) => sum + d.amount, 0);

    return Response.json({
      time_series: [],
      breakdowns: { by_violation_type, by_account_size: [], by_challenge_type: [] },
      totals: {
        count: allDeductions.length,
        total_amount: totalAmount,
      },
      comparison: {
        platform_reported: totalAmount,
        platform_count: allDeductions.length,
        calculated: totalAmount,
        calculated_count: allDeductions.length,
        difference: 0,
        difference_count: 0,
        news_removed: 0,
        flagged_deductions: [],
        platform_details: detailList,
        analysis_details: detailList,
      },
    });
  } catch (err) {
    logError('Failed to fetch deductions summary', err, { route: '/api/platform/deductions/summary', category: 'external_api' });
    return Response.json({ error: 'Failed to fetch deductions summary' }, { status: 500 });
  }
}
