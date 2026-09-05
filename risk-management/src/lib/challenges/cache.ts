import { createAdminClient } from '@/lib/supabase/admin';
import {
  fetchAccountTradeData,
  type ChallengeAccountSearchResult,
} from '@/lib/platform/client';
import { analyzeTradesDetailed } from '@/lib/payouts/detailed-risk-analysis';
import { fetchNewsEventsFromDB } from '@/lib/news/db';

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
const PHASE_LABELS: Record<number, string> = { 1: 'Phase 1', 2: 'Phase 2', 3: 'Phase 3' };
const TYPE_LABELS: Record<number, string> = { 1: 'One Phase', 2: 'Pro', 3: 'Flex', 4: 'Instant', 5: 'Instant Pro' };

function hasNewsAddon(planName: string): boolean {
  return planName.toUpperCase().includes(',NT') || planName.toUpperCase().endsWith('NT');
}

function isFlexAccount(planName: string): boolean {
  return planName.toUpperCase().includes('FLEX');
}

const na = (v: unknown) =>
  v == null || v === 'N/A' || v === 'n/a' || v === 'NA' || v === '' ? '' : String(v);

export interface CachedChallengeAccount {
  account_id: string;
  login: string;
  email: string;
  first_name: string;
  last_name: string;
  country: string;
  plan: string;
  plan_type: string;
  phase: number;
  phase_label: string;
  starting_balance: number;
  balance: number;
  equity: number;
  total_deductions: number;
  violation_count: number;
  violation_types: string[];
  violation_labels: string[];
  deduction_breakdown: Record<string, number>;
  violation_details: Record<string, { trade_id: string; explanation: string; amount: number }[]>;
  severity: string;
  flagged_trade_count: number;
  ban_news_trading: boolean;
  ban_hft: boolean;
  ban_mtgl: boolean;
  traded_days: number;
  has_news_addon: boolean;
  added_at: string;
  pass_date: string;
  processed_at: string;
  trades: Array<{
    _id: string; position?: string; trdSymbol: string; side: string; lots: number;
    openTime: string; closeTime: string; openPrice: number; closePrice: number;
    profit: number; commission: number; swap: number; duration: number;
  }>;
  news_events: Array<{ title: string; country: string; date: string; impact: string; source: string }>;
}

/**
 * Analyze a single account's trades and return cache-ready data.
 */
export async function analyzeAccount(acct: ChallengeAccountSearchResult, tenantId: string): Promise<CachedChallengeAccount | null> {
  const accountId = acct.accountId.toString();
  const email = na(acct.email);
  const plan = acct.planName || '';

  let breakdownByType: Record<string, number> = {};
  let detailsByType: Record<string, { trade_id: string; explanation: string; amount: number }[]> = {};
  let violationCount = 0;
  let flaggedTradeCount = 0;
  let newsEventsData: Array<{ title: string; country: string; date: string; impact: string; source: string }> = [];
  let rawTrades: Array<{
    _id: string; trdSymbol: string; side: string; lots: number;
    openTime: string; closeTime: string; openPrice: number; closePrice: number;
    profit: number; commission: number; swap: number; duration: number;
  }> = [];

  if (email) {
    try {
      // Timeout trade fetch after 15 seconds to avoid hanging
      const tradeData = await Promise.race([
        fetchAccountTradeData(accountId, email, tenantId),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000)),
      ]);
      if (tradeData && tradeData.trades.length > 0) {
        rawTrades = tradeData.trades.map((t) => ({
          _id: t._id, position: t.position, trdSymbol: t.trdSymbol, side: t.side, lots: t.lots,
          openTime: t.openTime, closeTime: t.closeTime, openPrice: t.openPrice,
          closePrice: t.closePrice, profit: t.profit, commission: t.commission || 0,
          swap: t.swap || 0, duration: t.duration,
        }));
        // Fetch actual news events for the trade date range (with 10s timeout)
        let newsEvents;
        try {
          const tradeTimes = tradeData.trades.map((t) => new Date(t.openTime).getTime());
          const minTime = Math.min(...tradeTimes);
          const maxTime = Math.max(...tradeTimes);
          const rangeStart = new Date(minTime);
          rangeStart.setUTCHours(0, 0, 0, 0);
          const rangeEnd = new Date(maxTime);
          rangeEnd.setUTCHours(23, 59, 59, 999);
          newsEvents = await Promise.race([
            fetchNewsEventsFromDB(rangeStart, rangeEnd),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 10000)),
          ]);
        } catch {
          // If news fetch fails, proceed without news events
        }

        const analysis = analyzeTradesDetailed(
          tradeData.trades,
          acct.priorDayBalance || acct.startingBalance,
          acct.priorDayEquity,
          newsEvents || undefined,
          acct.startingBalance
        );

        for (const [typeKey, amount] of Object.entries(analysis.summary.deductionsByType)) {
          if (amount <= 0) continue;
          const canonical = CANONICAL_TYPE[typeKey] || typeKey;

          if (canonical === 'news' && hasNewsAddon(plan)) continue;

          breakdownByType[canonical] = (breakdownByType[canonical] || 0) + amount;
        }

        // Collect per-trade violation details grouped by canonical type
        for (const v of analysis.violations) {
          const canonical = CANONICAL_TYPE[v.typeKey] || v.typeKey;
          if (canonical === 'news' && hasNewsAddon(plan)) continue;
          if (v.deductionAmount <= 0) continue;

          if (!detailsByType[canonical]) detailsByType[canonical] = [];
          detailsByType[canonical].push({
            trade_id: v.trade.position || v.trade._id,
            explanation: v.explanation,
            amount: v.deductionAmount,
          });
        }

        violationCount = analysis.summary.violatingTradeCount;
        flaggedTradeCount = Object.values(analysis.summary.violationTypeCount).reduce((s, c) => s + c, 0);
        newsEventsData = analysis.newsEvents || [];
      }
    } catch {
      // Skip accounts where trade fetch fails
    }
  }

  const violationTypes = Object.keys(breakdownByType);
  const totalDeductions = Object.values(breakdownByType).reduce((s, a) => s + a, 0);
  const severity = totalDeductions > 500 ? 'critical' : totalDeductions > 200 ? 'high' : totalDeductions > 50 ? 'medium' : 'low';

  return {
    account_id: accountId,
    login: na(acct.login),
    email,
    first_name: na(acct.firstName),
    last_name: na(acct.lastName),
    country: na(acct.country),
    plan,
    plan_type: TYPE_LABELS[acct.type] || String(acct.type),
    phase: acct.phase,
    phase_label: PHASE_LABELS[acct.phase] || `Phase ${acct.phase}`,
    starting_balance: acct.startingBalance || 0,
    balance: acct.lastBalance || 0,
    equity: acct.lastEquity || 0,
    total_deductions: totalDeductions,
    violation_count: violationCount,
    violation_types: violationTypes,
    violation_labels: violationTypes.map((t) => VIOLATION_TYPE_LABELS[t] || t),
    deduction_breakdown: breakdownByType,
    violation_details: detailsByType,
    severity,
    flagged_trade_count: flaggedTradeCount,
    ban_news_trading: acct.banNewsTrading === 1,
    ban_hft: acct.banHFT === 1,
    ban_mtgl: acct.banMTGL === 1,
    traded_days: acct.tradedDays || 0,
    has_news_addon: hasNewsAddon(plan),
    added_at: acct.addedUTC || '',
    pass_date: acct.lastUpdatedUTC || '',
    processed_at: new Date().toISOString(),
    trades: rawTrades,
    news_events: newsEventsData,
  };
}

/**
 * Save analyzed accounts to the cache table.
 */
export async function saveToCacheDB(accounts: CachedChallengeAccount[]): Promise<void> {
  if (accounts.length === 0) return;
  const supabase = createAdminClient();

  // Upsert in batches of 50
  for (let i = 0; i < accounts.length; i += 50) {
    const batch = accounts.slice(i, i + 50);
    const { error } = await supabase
      .from('challenge_violation_cache')
      .upsert(batch, { onConflict: 'account_id' });
    if (error) {
      console.error('[saveToCacheDB] Supabase upsert error:', error.message, error.details, error.hint);
    }
  }
}

/**
 * Get all cached challenge accounts (for dashboard/violations/deductions).
 */
export async function getCachedAccounts(filters?: {
  search?: string;
  violationType?: string;
  phase?: number;
  withViolationsOnly?: boolean;
}): Promise<CachedChallengeAccount[]> {
  const supabase = createAdminClient();
  let query = supabase
    .from('challenge_violation_cache')
    .select('*')
    .order('total_deductions', { ascending: false });

  if (filters?.withViolationsOnly) {
    query = query.gt('total_deductions', 0);
  }
  if (filters?.phase) {
    query = query.eq('phase', filters.phase);
  }
  if (filters?.violationType) {
    query = query.contains('violation_types', [filters.violationType]);
  }
  if (filters?.search) {
    const safe = filters.search.replace(/[^A-Za-z0-9 @._-]/g, '').replace(/[%_]/g, m => '\\' + m);
    if (safe) {
      query = query.or(`login.ilike.%${safe}%,account_id.ilike.%${safe}%,email.ilike.%${safe}%,first_name.ilike.%${safe}%,last_name.ilike.%${safe}%`);
    }
  }

  const { data, error } = await query;
  if (error) {
    console.error('[getCachedAccounts] Supabase query error:', error.message, error.details);
  }
  return (data || []) as CachedChallengeAccount[];
}

/**
 * Lightweight stats-only query — skips heavy JSONB columns (trades, news_events, violation_details).
 */
export async function getCachedAccountStats(): Promise<{ total_deductions: number; deduction_breakdown: Record<string, number> }[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('challenge_violation_cache')
    .select('total_deductions, deduction_breakdown');
  if (error) {
    console.error('[getCachedAccountStats] error:', error.message, error.details);
  }
  return (data || []) as { total_deductions: number; deduction_breakdown: Record<string, number> }[];
}

/**
 * Get a single cached account by ID.
 */
export async function getCachedAccount(accountId: string): Promise<CachedChallengeAccount | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('challenge_violation_cache')
    .select('*')
    .eq('account_id', accountId)
    .single();
  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found (expected)
    console.error('[getCachedAccount] Supabase query error:', error.message, error.details);
  }
  return data as CachedChallengeAccount | null;
}

/**
 * Batch-check which account IDs already exist in cache.
 */
export async function getCachedAccountIds(accountIds: string[]): Promise<Set<string>> {
  const supabase = createAdminClient();
  const result = new Set<string>();
  // Query in chunks of 100 to avoid URL length limits
  for (let i = 0; i < accountIds.length; i += 100) {
    const chunk = accountIds.slice(i, i + 100);
    const { data, error } = await supabase
      .from('challenge_violation_cache')
      .select('account_id')
      .in('account_id', chunk);
    if (error) {
      console.error('[getCachedAccountIds] Supabase query error:', error.message, error.details, 'chunk sample:', chunk.slice(0, 3));
    }
    if (data) {
      for (const row of data) result.add(row.account_id);
    }
  }
  return result;
}

