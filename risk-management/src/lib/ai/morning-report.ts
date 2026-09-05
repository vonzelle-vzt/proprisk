import {
  fetchPendingPayouts,
  fetchAccountMetrics,
  fetchAccountDetails,
  fetchUserDetails,
} from '@/lib/platform/client';
import { computeRiskScore } from './analytics';
import { formatMorningReportResponse } from './response-formatter';
import type { MorningReportData } from '@/types/ai';

const CONCURRENCY = 5;

interface EnrichedAccountData {
  accountId: string;
  login: string;
  email: string;
  plan: string;
  payoutAmount: number;
  totalDeductions: number;
  violationTypes: string[];
  breakdownByType: Record<string, number>;
  isBlackListed: boolean;
  blackListReason: string | null;
  kycVerified: boolean;
  kycStatus: string;
  riskScore: number;
  riskReasons: string[];
}

export async function generateMorningReportData(tenantId: string): Promise<MorningReportData> {
  // Fetch ALL pending payouts — no date-field to ensure nothing is excluded
  const payouts = await fetchPendingPayouts(
    {
      statuses: ['Pending'],
      limit: 1000,
    },
    tenantId
  );

  // Deduplicate by accountId
  const uniqueAccounts = new Map<string, (typeof payouts)[0]>();
  for (const p of payouts) {
    if (p.accountId && !uniqueAccounts.has(p.accountId)) {
      uniqueAccounts.set(p.accountId, p);
    }
  }

  const accounts = Array.from(uniqueAccounts.values());
  const enrichedAccounts: EnrichedAccountData[] = [];

  // Process with bounded concurrency
  for (let i = 0; i < accounts.length; i += CONCURRENCY) {
    const batch = accounts.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (payout) => {
        const accountId = payout.accountId.toString();
        const [metrics, accountDetails] = await Promise.all([
          fetchAccountMetrics(accountId, tenantId),
          fetchAccountDetails(accountId, tenantId),
        ]);

        const userId = accountDetails?.userId || payout.userId;
        const userDetails = userId ? await fetchUserDetails(userId, tenantId) : null;

        const deductions = metrics.deductions;
        const breakdownByType = deductions?.breakdownByType || {};
        const violationTypes = Object.keys(breakdownByType).filter((k) => breakdownByType[k] > 0);
        const totalDeductions = deductions?.totalDeductions || 0;

        const riskResult = computeRiskScore({
          deductions: deductions || null,
          account: accountDetails,
          user: userDetails,
          payoutAmount: payout.amount || payout.clientPayout || 0,
        });

        return {
          accountId,
          login: payout.login?.toString() || accountDetails?.login?.toString() || '',
          email: payout.email || userDetails?.email || '',
          plan: accountDetails?.planName || payout.plan || '',
          payoutAmount: payout.amount || payout.clientPayout || 0,
          totalDeductions,
          violationTypes,
          breakdownByType,
          isBlackListed: userDetails?.isBlackListed === 1,
          blackListReason: userDetails?.blackListReason || null,
          kycVerified: userDetails?.isKycVerified === 1,
          kycStatus: userDetails?.kycStatus || 'Unknown',
          riskScore: riskResult.score,
          riskReasons: riskResult.reasons,
        } satisfies EnrichedAccountData;
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') enrichedAccounts.push(r.value);
    }
  }

  // Compute aggregates
  const totalPayoutAmount = enrichedAccounts.reduce((s, a) => s + a.payoutAmount, 0);
  const totalDeductions = enrichedAccounts.reduce((s, a) => s + a.totalDeductions, 0);
  const accountsWithViolations = enrichedAccounts.filter((a) => a.totalDeductions > 0);
  const blacklistedAccounts = enrichedAccounts.filter((a) => a.isBlackListed);
  const kycFailures = enrichedAccounts.filter((a) => !a.kycVerified);
  const highRiskAccounts = enrichedAccounts.filter((a) => a.riskScore >= 50);

  // Violation type aggregation
  const violationByType: Record<string, number> = {};
  for (const acct of accountsWithViolations) {
    for (const type of acct.violationTypes) {
      violationByType[type] = (violationByType[type] || 0) + 1;
    }
  }

  // Plan distribution
  const planDist: Record<string, { count: number; totalPayout: number }> = {};
  for (const acct of enrichedAccounts) {
    const plan = acct.plan || 'Unknown';
    if (!planDist[plan]) planDist[plan] = { count: 0, totalPayout: 0 };
    planDist[plan].count++;
    planDist[plan].totalPayout += acct.payoutAmount;
  }

  // Severity distribution
  const severityDist: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const acct of enrichedAccounts) {
    const level = acct.riskScore >= 70 ? 'critical' : acct.riskScore >= 50 ? 'high' : acct.riskScore >= 25 ? 'medium' : 'low';
    severityDist[level]++;
  }

  const reportData: MorningReportData = {
    pending_payouts: {
      count: enrichedAccounts.length,
      total_amount: totalPayoutAmount,
    },
    violations: {
      total: accountsWithViolations.reduce((s, a) => s + a.violationTypes.length, 0),
      by_type: violationByType,
      accounts_with_violations: accountsWithViolations.length,
    },
    deductions: {
      total_amount: totalDeductions,
      top_accounts: [...enrichedAccounts]
        .sort((a, b) => b.totalDeductions - a.totalDeductions)
        .filter((a) => a.totalDeductions > 0)
        .slice(0, 10)
        .map((a) => ({
          accountId: a.accountId,
          login: a.login,
          amount: a.totalDeductions,
          plan: a.plan,
        })),
    },
    security_flags: {
      blacklisted_users: blacklistedAccounts.map((a) => ({
        accountId: a.accountId,
        email: a.email,
        reason: a.blackListReason,
      })),
      kyc_failures: kycFailures.length,
      high_risk_count: highRiskAccounts.length,
    },
    top_risk_accounts: [...enrichedAccounts]
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 10)
      .map((a) => ({
        accountId: a.accountId,
        login: a.login,
        risk_score: a.riskScore,
        reasons: a.riskReasons,
      })),
    severity_distribution: severityDist,
    plan_distribution: Object.entries(planDist)
      .map(([plan, data]) => ({ plan, ...data }))
      .sort((a, b) => b.count - a.count),
    generated_at: new Date().toISOString(),
  };

  return reportData;
}

export function formatMorningReport(data: MorningReportData): string {
  return formatMorningReportResponse(data);
}
