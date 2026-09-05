import { createAdminClient } from '@/lib/supabase/admin';
import { logError } from '@/lib/logging/logger';
import type { PayoutRecord } from '@/types/payouts';

/**
 * Persist account + user data to Supabase so it's never lost.
 * Upserts on platform_account_id — always keeps the latest version.
 * Fire-and-forget: failures are logged but don't block the caller.
 */
export async function saveAccountSnapshot(record: PayoutRecord): Promise<void> {
  if (!record.accountId) return;

  const sb = createAdminClient();

  const row = {
    platform_account_id: record.accountId,
    login: record.login || null,
    email: record.email || null,
    first_name: record.firstName || null,
    last_name: record.lastName || null,
    country: record.country || record.kycCountry || null,
    kyc_status: record.kycStatus || null,
    kyc_verified: record.kycVerified || false,
    is_blacklisted: record.isBlackListed || false,
    plan: record.plan || null,
    starting_balance: record.startingBalance || record.accountSize || null,
    balance: record.balance ?? null,
    total_pnl: record.totalPnL ?? null,
    traded_days: record.tradedDays ?? null,
    max_daily_profit: record.maxDailyProfit ?? null,
    num_approved_payouts: record.numApprovedPayouts ?? null,
    approved_payouts_total: record.approvedPayouts ?? null,
    ban_news_trading: record.banNewsTrading || false,
    ban_hft: record.banHFT || false,
    ban_mtgl: record.banMTGL || false,
    deductions_total: record.platformDeductions?.totalDeductions || 0,
    deductions_by_type: record.platformDeductions?.breakdownByType || {},
    violation_count: record.platformDeductions?.violationCount || 0,
    snapshot_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { error } = await sb
    .from('account_snapshots')
    .upsert(row, { onConflict: 'platform_account_id' });

  if (error) {
    logError('Failed to save account snapshot', error, {
      route: 'lib/payouts/account-snapshot',
      category: 'database',
      account_id: record.accountId,
    });
  }
}
