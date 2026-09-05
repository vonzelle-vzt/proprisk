export const dynamic = 'force-dynamic';

import {
  fetchAccountsToMonitor,
  fetchAccountDetails,
  fetchUserDetails,
} from '@/lib/platform/client';
import { runLocalViolationAnalysis } from '@/lib/payouts/local-analysis';
import type { PlatformPayout } from '@/types/platform';
import { logError } from '@/lib/logging/logger';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { DEMO_MODE, assetClassFromRequest } from '@/lib/demo';
import { buildDashboard } from '@/lib/mock/builders';
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

const CANONICAL_TYPE: Record<string, string> = {};

interface DashboardAccount {
  accountId: string;
  login: string;
  email: string;
  firstName: string;
  lastName: string;
  country: string;
  kycStatus: string;
  isBlackListed: boolean;
  plan: string;
  startingBalance: number;
  balance: number;
  totalPnL: number;
  payoutAmount: number;
  payoutRequestAmount: number;
  payoutClientAmount: number;
  profitSharePercentage: number | null;
  payoutStatus: string;
  payoutRequested: string;
  totalDeductions: number;
  violationCount: number;
  violationTypes: string[];
  violationLabels: string[];
  deductionBreakdown: Record<string, number>;
  severity: 'low' | 'medium' | 'high' | 'critical';
  banNewsTrading: boolean;
  banHFT: boolean;
  banMTGL: boolean;
  tradedDays: number;
  numApprovedPayouts: number;
  approvedPayouts: number;
  consistencyAtRequest: number | null;
  consistencyRequired: number | null;
  closedPnL: number | null;
  accountMetrics: Record<string, any>;
}

export async function GET(req: Request) {
  if (DEMO_MODE) return Response.json(buildDashboard(assetClassFromRequest(req)));

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  // Live path only (demo serves static mocks above): these routes fan out to
  // the provider API, so throttle them.
  const rl = await checkRateLimit('platform-dashboard', { windowMs: 60_000, maxRequests: 10 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    // Accounts to monitor: pending payouts if the provider has a payout queue,
    // else the full account book (trading platforms).
    const payouts = await fetchAccountsToMonitor(auth.tenantId);

    // Deduplicate by accountId — keep the most recent payout per account
    const uniqueAccounts = new Map<string, PlatformPayout>();
    for (const p of payouts) {
      if (p.accountId && !uniqueAccounts.has(p.accountId)) {
        uniqueAccounts.set(p.accountId, p);
      }
    }

    const accounts = Array.from(uniqueAccounts.values());
    const enrichedAccounts: DashboardAccount[] = [];

    // Process with bounded concurrency
    for (let i = 0; i < accounts.length; i += CONCURRENCY) {
      const batch = accounts.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (payout) => {
          const accountId = payout.accountId.toString();
          const accountDetails = await fetchAccountDetails(accountId, auth.tenantId);

          const userId = accountDetails?.userId || payout.userId;
          const userDetails = userId ? await fetchUserDetails(userId, auth.tenantId) : null;

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

          const breakdownByType = localResult.mergedBreakdown;
          const violationTypes = localResult.mergedViolationTypes;
          const totalDeductions = localResult.mergedTotal;

          const severity: 'low' | 'medium' | 'high' | 'critical' =
            totalDeductions > 500 ? 'critical' : totalDeductions > 200 ? 'high' : totalDeductions > 50 ? 'medium' : 'low';

          const na = (v: unknown) => (v == null || v === 'N/A' || v === 'n/a' || v === 'NA' || v === '') ? '' : String(v);

          return {
            accountId,
            login: na(payout.login) || na(accountDetails?.login) || '',
            email,
            firstName: na(userDetails?.firstName),
            lastName: na(userDetails?.lastName),
            country: na(userDetails?.country) || na(payout.country) || '',
            kycStatus: na(userDetails?.kycStatus) === 'COMPLETED' ? 'Verified' : na(userDetails?.kycStatus) || 'Unknown',
            isBlackListed: userDetails?.isBlackListed === 1,
            plan: accountDetails?.planName || payout.plan || '',
            startingBalance: accountDetails?.startingBalance || 0,
            balance: payout.balance || accountDetails?.lastBalance || 0,
            totalPnL: payout.totalPnL || 0,
            payoutAmount: payout.clientPayout || payout.amount || 0,
            payoutRequestAmount: payout.amount || 0,
            payoutClientAmount: payout.clientPayout || payout.amount || 0,
            profitSharePercentage: payout.profitSharePercentage ?? null,
            payoutStatus: payout.status || 'Pending',
            payoutRequested: payout.statusChanged || payout.requested || payout.createdAt || '',
            totalDeductions,
            violationCount: localResult.localAnalysis.summary.violatingTradeCount,
            violationTypes,
            violationLabels: violationTypes.map(t => VIOLATION_TYPE_LABELS[t] || t),
            deductionBreakdown: breakdownByType,
            severity,
            banNewsTrading: accountDetails?.banNewsTrading === 1,
            banHFT: accountDetails?.banHFT === 1,
            banMTGL: accountDetails?.banMTGL === 1,
            tradedDays: accountDetails?.tradedDays || 0,
            numApprovedPayouts: accountDetails?.numApprovedPayouts || 0,
            approvedPayouts: accountDetails?.approvedPayouts || 0,
            consistencyAtRequest: accountDetails?._curConsistencyPct || null,
            consistencyRequired: accountDetails?.consistencyPct || null,
            closedPnL: null,
            accountMetrics: {},
          } satisfies DashboardAccount;
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled') enrichedAccounts.push(r.value);
      }
    }

    // --- Compute dashboard aggregates ---

    const totalPayoutAmount = enrichedAccounts.reduce((s, a) => s + a.payoutAmount, 0);
    const totalDeductionsAll = enrichedAccounts.reduce((s, a) => s + a.totalDeductions, 0);
    const accountsWithViolations = enrichedAccounts.filter(a => a.totalDeductions > 0);
    const blacklistedAccounts = enrichedAccounts.filter(a => a.isBlackListed);

    // Violation type aggregation (normalize aliases)
    const violationTypeTotals: Record<string, { count: number; amount: number }> = {};
    for (const acct of enrichedAccounts) {
      for (const [rawType, amount] of Object.entries(acct.deductionBreakdown)) {
        if (amount <= 0) continue;
        const type = CANONICAL_TYPE[rawType] || rawType;
        if (!violationTypeTotals[type]) violationTypeTotals[type] = { count: 0, amount: 0 };
        violationTypeTotals[type].count++;
        violationTypeTotals[type].amount += amount;
      }
    }

    // Severity distribution
    const severityDistribution = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const acct of accountsWithViolations) {
      severityDistribution[acct.severity]++;
    }

    // Plan distribution
    const planDistribution: Record<string, { count: number; totalPayout: number }> = {};
    for (const acct of enrichedAccounts) {
      const plan = acct.plan || 'Unknown';
      if (!planDistribution[plan]) planDistribution[plan] = { count: 0, totalPayout: 0 };
      planDistribution[plan].count++;
      planDistribution[plan].totalPayout += acct.payoutAmount;
    }

    // Country distribution
    const countryDistribution: Record<string, number> = {};
    for (const acct of enrichedAccounts) {
      const c = acct.country || 'Unknown';
      countryDistribution[c] = (countryDistribution[c] || 0) + 1;
    }

    // Top flagged accounts (by deduction amount, descending)
    const topFlagged = [...accountsWithViolations]
      .sort((a, b) => b.totalDeductions - a.totalDeductions)
      .slice(0, 20);

    // Top payouts (by payout amount, descending)
    const topPayouts = [...enrichedAccounts]
      .sort((a, b) => b.payoutAmount - a.payoutAmount)
      .slice(0, 20);

    return Response.json({
      summary: {
        totalPendingPayouts: enrichedAccounts.length,
        totalPayoutAmount,
        totalDeductions: totalDeductionsAll,
        accountsWithViolations: accountsWithViolations.length,
        blacklistedAccounts: blacklistedAccounts.length,
        avgPayoutAmount: enrichedAccounts.length > 0 ? totalPayoutAmount / enrichedAccounts.length : 0,
        avgDeductionPerViolatedAccount: accountsWithViolations.length > 0 ? totalDeductionsAll / accountsWithViolations.length : 0,
      },
      violationTypeBreakdown: Object.entries(violationTypeTotals)
        .map(([type, data]) => ({
          type,
          label: VIOLATION_TYPE_LABELS[type] || type,
          count: data.count,
          amount: data.amount,
        }))
        .sort((a, b) => b.amount - a.amount),
      severityDistribution,
      planDistribution: Object.entries(planDistribution)
        .map(([plan, data]) => ({ plan, ...data }))
        .sort((a, b) => b.count - a.count),
      countryDistribution: Object.entries(countryDistribution)
        .map(([country, count]) => ({ country, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 15),
      topFlaggedAccounts: topFlagged,
      topPayouts,
      allAccounts: enrichedAccounts,
    });
  } catch (err) {
    logError('Failed to load dashboard', err, { route: '/api/platform/dashboard', category: 'external_api' });
    return Response.json({ error: 'Failed to load dashboard' }, { status: 500 });
  }
}
