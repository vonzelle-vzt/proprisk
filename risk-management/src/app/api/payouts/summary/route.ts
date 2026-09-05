export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { fetchPendingPayouts, fetchAccountDetails, fetchUserDetails } from '@/lib/platform/client';
import { runLocalViolationAnalysis } from '@/lib/payouts/local-analysis';
import { logError } from '@/lib/logging/logger';
import { DEMO_MODE, assetClassFromRequest } from '@/lib/demo';
import { buildPayoutSummary } from '@/lib/mock/builders';
import { requireRiskUser } from '@/lib/auth/guards';

const CONCURRENCY = 5;

export async function GET(_request: NextRequest) {
  if (DEMO_MODE) return Response.json(buildPayoutSummary(assetClassFromRequest(_request)));

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  try {
    // Fetch ALL pending payouts — no date-field to ensure nothing is excluded
    const payouts = await fetchPendingPayouts({
      statuses: ['Pending'],
      limit: 1000,
    }, auth.tenantId);

    // Deduplicate by _id (the platform provides _id for payouts)
    const payoutMap = new Map<string, any>();
    for (const p of payouts) {
      const id = p._id || `${p.accountId}-${p.orderId}`;
      if (!payoutMap.has(id)) payoutMap.set(id, p);
    }

    // Status=Pending already requested from the provider platform
    const pending = Array.from(payoutMap.values());

    const totalClientAmount = pending.reduce((sum: number, p: any) => {
      const amt = typeof p.clientPayout === 'number' ? p.clientPayout : Number(p.clientPayout) || 0;
      return sum + amt;
    }, 0);

    // Run local violation analysis for unique accounts
    let violationFlags = 0;
    let totalDeductions = 0;

    const accountIds = [...new Set(pending.map((p: any) => p.accountId).filter(Boolean))];
    const sample = accountIds.slice(0, 50);

    // Map accountId → payout for email/userId lookup
    const payoutByAccount = new Map<string, any>();
    for (const p of pending) {
      if (p.accountId && !payoutByAccount.has(String(p.accountId))) {
        payoutByAccount.set(String(p.accountId), p);
      }
    }

    for (let i = 0; i < sample.length; i += CONCURRENCY) {
      const batch = sample.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (id) => {
          const accountId = String(id);
          const payout = payoutByAccount.get(accountId);
          const [accountDetails, userDetails] = await Promise.all([
            fetchAccountDetails(accountId, auth.tenantId),
            payout?.userId ? fetchUserDetails(payout.userId, auth.tenantId) : Promise.resolve(null),
          ]);

          const email = payout?.email || userDetails?.email || '';
          const localResult = await runLocalViolationAnalysis({
            accountId,
            email,
            startingBalance: accountDetails?.startingBalance || 0,
            priorDayBalance: accountDetails?.priorDayBalance,
            priorDayEquity: accountDetails?.priorDayEquity,
            planName: accountDetails?.planName || payout?.plan || '',
            tenantId: auth.tenantId,
          });

          return localResult;
        })
      );
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const localResult = r.value;
        if (localResult.mergedTotal > 0) {
          violationFlags++;
          totalDeductions += localResult.mergedTotal;
        }
      }
    }

    return Response.json({
      data: {
        total: pending.length,
        ipFlags: 0,
        investigations: 0,
        totalClientAmount,
        violationFlags,
        totalDeductions,
      },
    }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (err) {
    logError('Failed to fetch summary', err, { route: '/api/payouts/summary', category: 'external_api' });
    return Response.json({ error: 'Failed to fetch summary' }, { status: 500 });
  }
}
