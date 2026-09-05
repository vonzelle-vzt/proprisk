import type { DashboardAccount } from '@/hooks/use-platform-dashboard';
import type { PayoutRecord } from '@/types/payouts';

/** Dashboard Account → PayoutRecord adapter, shared by the flagged + all-payouts tabs. */
export function dashToPayoutRecord(acct: DashboardAccount): PayoutRecord {
  return {
    id: acct.accountId,
    _id: acct.accountId,
    orderNumber: '',
    accountId: acct.accountId,
    login: acct.login,
    email: acct.email,
    firstName: acct.firstName,
    lastName: acct.lastName,
    country: acct.country,
    kycStatus: acct.kycStatus,
    kycCountry: acct.country,
    isBlackListed: acct.isBlackListed,
    plan: acct.plan,
    startingBalance: acct.startingBalance,
    accountSize: acct.startingBalance,
    balance: acct.balance,
    totalPnL: acct.totalPnL,
    amount: acct.payoutRequestAmount || acct.payoutAmount,
    clientAmount: acct.payoutClientAmount || acct.payoutAmount,
    profitSharePercentage: acct.profitSharePercentage ?? undefined,
    dateRequested: acct.payoutRequested,
    tradedDays: acct.tradedDays,
    banNewsTrading: acct.banNewsTrading,
    banHFT: acct.banHFT,
    banMTGL: acct.banMTGL,
    numApprovedPayouts: acct.numApprovedPayouts,
    approvedPayouts: acct.approvedPayouts,
    consistencyAtRequest: acct.consistencyAtRequest,
    consistencyRequired: acct.consistencyRequired,
    platformDeductions: acct.totalDeductions > 0 ? {
      totalDeductions: acct.totalDeductions,
      breakdownByType: acct.deductionBreakdown,
      violationCount: acct.violationCount,
      percentOfStartingBalance: acct.startingBalance > 0 ? (acct.totalDeductions / acct.startingBalance) * 100 : 0,
      percentOfTotalPL: 0,
    } : undefined,
    platformViolations: acct.violationTypes,
    status: 'Pending',
    notes: '',
  } as PayoutRecord;
}
