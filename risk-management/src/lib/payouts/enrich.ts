import { fetchAccountDetails, fetchUserDetails } from '@/lib/platform/client';
import type { PayoutRecord } from '@/types/payouts';
import { saveAccountSnapshot } from '@/lib/payouts/account-snapshot';
import { runLocalViolationAnalysis } from '@/lib/payouts/local-analysis';

export interface EnrichedPayout extends PayoutRecord {
  violationResult: null;
}

const CONCURRENCY = 5;

async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));
    for (const r of batchResults) {
      results.push(r.status === 'fulfilled' ? r.value : (undefined as unknown as R));
    }
  }
  return results;
}

/** Strip "N/A" string values, returning undefined */
function cleanNA(v: unknown): string | undefined {
  if (v == null || v === 'N/A' || v === 'n/a' || v === 'NA' || v === '') return undefined;
  return String(v);
}

async function enrichSingle(record: PayoutRecord, tenantId: string): Promise<EnrichedPayout> {
  const accountId = record.accountId;
  const userId = record.userId;

  try {
    const [accountDetails, userDetails] = await Promise.all([
      fetchAccountDetails(accountId, tenantId),
      userId ? fetchUserDetails(userId, tenantId) : Promise.resolve(null),
    ]);

    // Run local violation analysis — same logic as challenges, all types
    const localResult = await runLocalViolationAnalysis({
      accountId,
      email: record.email || cleanNA(userDetails?.email) || '',
      startingBalance: accountDetails?.startingBalance || 0,
      priorDayBalance: accountDetails?.priorDayBalance,
      priorDayEquity: accountDetails?.priorDayEquity,
      planName: cleanNA(accountDetails?.planName) || record.plan || '',
      tenantId,
    });

    // Build deductions object purely from local analysis
    const totalDeductions = localResult.mergedTotal;
    const startingBalance = accountDetails?.startingBalance || 0;
    const localDeductions = totalDeductions > 0
      ? {
          totalDeductions,
          breakdownByType: localResult.mergedBreakdown,
          violationCount: localResult.localAnalysis.summary.violatingTradeCount,
          percentOfStartingBalance: startingBalance > 0 ? (totalDeductions / startingBalance) * 100 : 0,
          percentOfTotalPL: 0,
        }
      : undefined;

    const rawKyc = cleanNA(userDetails?.kycStatus);

    const enriched: EnrichedPayout = {
      ...record,
      // User info
      firstName: cleanNA(userDetails?.firstName) || undefined,
      lastName: cleanNA(userDetails?.lastName) || undefined,
      kycStatus: rawKyc === 'COMPLETED' ? 'Verified' : rawKyc || record.kycStatus,
      kycVerified: userDetails?.isKycVerified === 1,
      kycStatusDetail: rawKyc || undefined,
      kycCountry: cleanNA(userDetails?.country) || record.kycCountry,
      country: cleanNA(userDetails?.country) || record.country,
      isBlackListed: userDetails?.isBlackListed === 1,
      // Account info
      plan: cleanNA(accountDetails?.planName) || record.plan,
      startingBalance: accountDetails?.startingBalance || undefined,
      accountSize: accountDetails?.startingBalance,
      tradedDays: accountDetails?.tradedDays || undefined,
      maxDailyProfit: accountDetails?.maxDailyProfit || undefined,
      maxDailyProfitPrev: accountDetails?._maxDailyProfitPrev || undefined,
      balanceAtRequest: accountDetails?._balanceAtRequest || record.balanceAtRequest,
      banNewsTrading: accountDetails?.banNewsTrading === 1,
      banHFT: accountDetails?.banHFT === 1,
      banMTGL: accountDetails?.banMTGL === 1,
      numApprovedPayouts: accountDetails?.numApprovedPayouts || undefined,
      approvedPayouts: accountDetails?.approvedPayouts || undefined,
      consistencyAtRequest: accountDetails?._curConsistencyPct || undefined,
      consistencyRequired: accountDetails?.consistencyPct || undefined,
      // Deductions — all from local analysis
      platformDeductions: localDeductions,
      platformViolations: localResult.mergedViolationTypes,
      violationResult: null,
    };

    // Persist account data to Supabase (fire-and-forget)
    saveAccountSnapshot(enriched).catch(() => { /* non-critical */ });

    return enriched;
  } catch {
    return {
      ...record,
      violationResult: null,
    };
  }
}

export async function enrichPayouts(records: PayoutRecord[], tenantId: string): Promise<EnrichedPayout[]> {
  return runWithConcurrency(records, (record) => enrichSingle(record, tenantId), CONCURRENCY);
}
