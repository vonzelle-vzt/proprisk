import { createAdminClient } from '@/lib/supabase/admin';
import type { PayoutRecord } from '@/types/payouts';
import type { PayoutDecision } from '@/types/history';
import { logError } from '@/lib/logging/logger';

export async function savePayoutSnapshot(
  record: PayoutRecord,
  decision: PayoutDecision,
  decidedBy: string,
  notes?: string,
  decidedAt?: string
): Promise<{ id: string } | null> {
  const sb = createAdminClient();

  const row = {
    platform_payout_id: record._id || record.id,
    platform_account_id: record.accountId,
    platform_order_id: record.orderId || record.orderNumber,
    login: record.login,
    customer_id: record.customerId,
    user_id: record.userId?.toString(),
    decision,
    decided_by: decidedBy,
    decided_at: decidedAt || new Date().toISOString(),
    decision_notes: notes || null,
    amount: record.amount ?? null,
    client_amount: record.clientAmount ?? null,
    fee: record.fee ?? null,
    profit_share_pct: record.profitSharePercentage ?? null,
    method: record.method || null,
    plan: record.plan || null,
    date_requested: record.dateRequested || null,
    balance: record.balance ?? null,
    total_pnl: record.totalPnL ?? null,
    starting_balance: record.startingBalance || record.accountSize || null,
    traded_days: record.tradedDays ?? null,
    max_daily_profit: record.maxDailyProfit ?? null,
    num_approved_payouts: record.numApprovedPayouts ?? null,
    approved_payouts_total: record.approvedPayouts ?? null,
    balance_at_request: record.balanceAtRequest ?? null,
    ban_news_trading: record.banNewsTrading || false,
    ban_hft: record.banHFT || false,
    ban_mtgl: record.banMTGL || false,
    email: record.email || null,
    first_name: record.firstName || null,
    last_name: record.lastName || null,
    country: record.country || record.kycCountry || null,
    kyc_status: record.kycStatus || null,
    kyc_verified: record.kycVerified || false,
    is_blacklisted: record.isBlackListed || false,
    pre_approved_status: record.preApprovedStatus ?? null,
    pre_approved_by: record.preApprovedBy || null,
    violations_list: record.platformViolations || [],
    deductions_total: record.platformDeductions?.totalDeductions || 0,
    deductions_violation_count: record.platformDeductions?.violationCount || 0,
    deductions_pct_starting_balance: record.platformDeductions?.percentOfStartingBalance || 0,
    deductions_pct_total_pl: record.platformDeductions?.percentOfTotalPL || 0,
    deductions_by_type: record.platformDeductions?.breakdownByType || {},
    full_snapshot: record,
  };

  const { data, error } = await sb
    .from('payout_history')
    .upsert(row, { onConflict: 'platform_payout_id,decision' })
    .select('id')
    .single();

  if (error) {
    logError('Failed to save payout snapshot', error, { route: 'lib/payouts/snapshot', category: 'database' });
    return null;
  }
  return data;
}
