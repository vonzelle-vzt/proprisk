import type { PlatformTrade, PlatformTradeStats, PlatformPayout, PlatformUser, PlatformAccount, PlatformLedgerEvent } from '@/types/platform';
import { DEMO_MODE } from '@/lib/demo';
import { getActiveProviders } from '@/lib/providers/adapters';
import type { TradingProvider } from '@/lib/providers/interface';
import type { NormalizedAccount, NormalizedTrade, NormalizedUser } from '@/lib/providers/types';

/**
 * Provider-neutral data-access facade for the live (non-demo) forex pipeline.
 *
 * Delegates to the active forex provider adapter (src/lib/providers/adapters),
 * mapping the normalized model back onto the Platform* shapes the payout /
 * dashboard / violation pipeline consumes. The active provider is whichever
 * forex adapter is enabled via env (PROVIDER_<ID>_ENABLED + creds).
 *
 * Notes / limitations of trading-platform providers (MatchTrader, etc.) vs the
 * legacy single-vendor integration:
 * - No payout-request queue: fetchPendingPayouts reflects the adapter's
 *   getPayouts(), which is [] for pure trading platforms. Pending-payout
 *   ingestion for those firms comes from their payout processor, wired
 *   separately. The risk dashboard's account list should be driven by
 *   listAccounts() for such providers (follow-up).
 * - No challenge-search / foreign-session idioms (those were specific to the legacy single-vendor integration).
 *
 * Demo mode never reaches this module — every data route short-circuits to
 * src/lib/mock before calling it.
 */
export class PlatformNotConfiguredError extends Error {
  constructor(operation: string) {
    super(
      `No live trading provider supports "${operation}". ` +
        `Enable a forex provider adapter (PROVIDER_<ID>_ENABLED + credentials) in src/lib/providers/adapters.`
    );
    this.name = 'PlatformNotConfiguredError';
  }
}

/**
 * Resolve the active forex provider. `tenantId` is required and threaded all
 * the way through to each adapter's config/cache resolution (see
 * src/lib/providers/adapters/base.ts). An optional tenant here is exactly how
 * a call site silently falls back to deployment-wide env-var credentials
 * instead of the calling tenant's own — the same shape of defect that once
 * caused a real cross-tenant leak in the fraud-hunter module. Every caller
 * must resolve a real tenant (route handlers via `auth.tenantId` from
 * src/lib/auth/guards.ts, background jobs via `fanOutToTenants`) before
 * reaching this facade.
 */
async function activeForexProvider(operation: string, tenantId: string): Promise<TradingProvider> {
  if (DEMO_MODE) throw new PlatformNotConfiguredError(operation);
  const candidates = getActiveProviders('forex');
  const configured = await Promise.all(candidates.map((p) => p.isConfigured(tenantId)));
  const provider = candidates.find((_, i) => configured[i]);
  if (!provider) throw new PlatformNotConfiguredError(operation);
  return provider;
}

// --- Normalized → Platform mappers ---

function toPlatformAccount(n: NormalizedAccount): PlatformAccount {
  return {
    login: Number(n.login) || 0,
    accountId: Number(n.id) || 0,
    userId: 0,
    planName: n.plan,
    startingBalance: n.startingBalance,
    lastBalance: n.balance,
    lastEquity: n.equity,
    banNewsTrading: n.banNewsTrading ? 1 : 0,
    banHFT: n.banHFT ? 1 : 0,
    banMTGL: n.banMartingale ? 1 : 0,
    maxOpenLots: n.maxPositionSize || undefined,
    tradedDays: n.tradedDays,
    disabled: n.canTrade ? 0 : 1,
    addedUTC: undefined,
  };
}

function toPlatformUser(n: NormalizedUser): PlatformUser {
  return {
    email: n.email,
    userId: Number(n.userId) || 0,
    customerId: n.userId,
    firstName: n.firstName,
    lastName: n.lastName,
    country: n.country,
    isKycVerified: n.kycStatus === 'Verified' ? 1 : 0,
    kycStatus: n.kycStatus,
    isBlackListed: n.isBlackListed ? 1 : 0,
  };
}

function toPlatformTrade(n: NormalizedTrade): PlatformTrade {
  return {
    _id: n.id,
    login: Number(n.accountId) || 0,
    accountId: Number(n.accountId) || 0,
    trdSymbol: n.symbol,
    stdSymbol: n.symbol,
    side: n.side,
    lots: n.sizeNative,
    volumeUSD: n.notionalUSD,
    openTime: n.openTime,
    openPrice: n.openPrice,
    closeTime: n.closeTime,
    closePrice: n.closePrice,
    duration: n.durationSec,
    profit: n.profit,
    commission: n.commission,
    swap: n.swap,
    reason: '',
  };
}

// --- Facade functions (delegated to the active provider) ---

export async function fetchAccountByLogin(
  _brokerId: number,
  loginId: string,
  tenantId: string
): Promise<Record<string, any>> {
  const provider = await activeForexProvider('fetchAccountByLogin', tenantId);
  const acct = provider.getAccount ? await provider.getAccount(loginId, tenantId) : null;
  return acct ? toPlatformAccount(acct) : {};
}

export async function fetchAccountDetails(accountId: string, tenantId: string): Promise<PlatformAccount | null> {
  const provider = await activeForexProvider('fetchAccountDetails', tenantId);
  const acct = provider.getAccount ? await provider.getAccount(accountId, tenantId) : null;
  return acct ? toPlatformAccount(acct) : null;
}

export async function fetchUserDetails(userId: string | number, tenantId: string): Promise<PlatformUser | null> {
  const provider = await activeForexProvider('fetchUserDetails', tenantId);
  const u = await provider.getUser(String(userId), tenantId);
  return u ? toPlatformUser(u) : null;
}

export async function fetchClosedTradeHistory(
  accountId: string,
  _userToken: string,
  _opts: { from?: string; to?: string; limit?: number; skip?: number } | undefined,
  tenantId: string
): Promise<{ trades: PlatformTrade[]; total: number }> {
  const provider = await activeForexProvider('fetchClosedTradeHistory', tenantId);
  const trades = (await provider.getClosedTradeHistory(accountId, tenantId)).map(toPlatformTrade);
  return { trades, total: trades.length };
}

export async function fetchTradeStats(
  _accountId: string,
  _userToken: string
): Promise<PlatformTradeStats | null> {
  // Aggregate stats are computed downstream from the trade list; adapters do
  // not expose a native stats endpoint. No live provider call — not part of
  // the tenant-credential attack surface this facade otherwise guards.
  return null;
}

export async function fetchAccountTradeData(
  accountId: string,
  _email: string,
  tenantId: string
): Promise<{ trades: PlatformTrade[]; tradeTotal: number; stats: PlatformTradeStats | null } | null> {
  const provider = await activeForexProvider('fetchAccountTradeData', tenantId);
  const trades = (await provider.getClosedTradeHistory(accountId, tenantId)).map(toPlatformTrade);
  return { trades, tradeTotal: trades.length, stats: null };
}

export async function fetchPendingPayouts(
  _params: {
    from?: string; to?: string; paid?: number; statuses?: string[]; dateField?: string; skip?: number; limit?: number;
  },
  tenantId: string
): Promise<PlatformPayout[]> {
  const provider = await activeForexProvider('fetchPendingPayouts', tenantId);
  const payouts = await provider.getPayouts(tenantId);
  return payouts.map((p) => ({
    _id: p.id,
    accountId: p.accountId,
    login: Number(p.login) || undefined,
    email: p.email,
    amount: p.amount,
    clientPayout: p.clientAmount,
    status: p.status,
    requested: p.requestedAt,
  }));
}

/**
 * Accounts to surface on the risk dashboard / violation scan. Prefers the
 * provider's pending-payout queue (as the legacy single-vendor integration provided); for trading
 * platforms with no payout queue, falls back to monitoring all accounts so the
 * dashboard shows the full book with risk analysis rather than being empty.
 */
export async function fetchAccountsToMonitor(tenantId: string): Promise<PlatformPayout[]> {
  const provider = await activeForexProvider('fetchAccountsToMonitor', tenantId);
  const payouts = await provider.getPayouts(tenantId);
  if (payouts.length > 0) {
    return payouts.map((p) => ({
      _id: p.id, accountId: p.accountId, login: Number(p.login) || undefined,
      email: p.email, amount: p.amount, clientPayout: p.clientAmount, status: p.status, requested: p.requestedAt,
    }));
  }
  const accounts = await provider.listAccounts(tenantId);
  return accounts.map((a) => ({
    _id: a.id,
    accountId: a.id,
    login: Number(a.login) || undefined,
    email: a.email,
    balance: a.balance,
    totalPnL: a.totalPnL,
    plan: a.plan,
    status: 'Monitored',
  }));
}

export async function fetchAccountMetrics(accountId: string, tenantId: string): Promise<{
  deductions: { totalDeductions: number; violationCount: number; percentOfStartingBalance: number; percentOfTotalPL: number; breakdownByType: Record<string, number> } | null;
  accountMetrics: Record<string, any>;
}> {
  const provider = await activeForexProvider('fetchAccountMetrics', tenantId);
  const [acct, violations] = await Promise.all([
    provider.getAccount ? provider.getAccount(accountId, tenantId) : Promise.resolve(null),
    provider.getRiskViolations(accountId, tenantId),
  ]);
  const breakdownByType: Record<string, number> = {};
  let totalDeductions = 0;
  for (const v of violations) {
    breakdownByType[v.type] = (breakdownByType[v.type] || 0) + v.deductionAmount;
    totalDeductions += v.deductionAmount;
  }
  const startBal = acct?.startingBalance || 0;
  const totalPnL = acct?.totalPnL || 0;
  return {
    deductions: totalDeductions > 0 || violations.length > 0
      ? {
          totalDeductions,
          violationCount: violations.length,
          percentOfStartingBalance: startBal > 0 ? Math.min((totalDeductions / startBal) * 100, 100) : 0,
          percentOfTotalPL: Math.abs(totalPnL) > 0 ? Math.min((totalDeductions / Math.abs(totalPnL)) * 100, 100) : 0,
          breakdownByType,
        }
      : null,
    accountMetrics: acct
      ? { login: acct.login, accountId: acct.id, startingBalance: startBal || null, totalPnL: totalPnL || null, accountSize: startBal || null }
      : {},
  };
}

export async function fetchLedgerEvents(
  _accountId: string,
  _opts: { skip?: number; limit?: number } | undefined,
  _tenantId: string
): Promise<PlatformLedgerEvent[]> {
  // Ledger (deposit/withdrawal) history is not surfaced through the unified
  // adapter contract; return [] so consumers degrade gracefully. No live
  // provider call today, but `tenantId` is required for consistency with the
  // rest of the facade so a future real implementation can't be wired up
  // without one.
  return [];
}

// --- Payout mutations: trading platforms have no payout-approval API ---

export async function preApprovePayout(_payoutId: string, _status: number, _note: string, _tenantId: string): Promise<{ Status: string }> {
  throw new PlatformNotConfiguredError('preApprovePayout');
}
export async function approvePayout(_payoutId: string, _approverId: string, _notes: string, _tenantId: string): Promise<{ Status: string }> {
  throw new PlatformNotConfiguredError('approvePayout');
}
export async function rejectPayout(_payoutId: string, _rejectionMessage: string, _approverId: string, _tenantId: string): Promise<{ Status: string }> {
  throw new PlatformNotConfiguredError('rejectPayout');
}

// --- Challenge-desk idioms (specific to the legacy single-vendor integration; not applicable to trading platforms) ---

export interface ChallengeAccountSearchResult {
  login: number;
  accountId: number;
  userId: number;
  planName: string;
  type: number;
  status: number;
  phase: number;
  startingBalance: number;
  lastBalance: number;
  lastEquity: number;
  priorDayBalance: number;
  priorDayEquity: number;
  tradedDays: number;
  banNewsTrading: number;
  banHFT: number;
  banMTGL: number;
  consistencyPct: number;
  _curConsistencyPct: number;
  numApprovedPayouts: number;
  approvedPayouts: number;
  email: string;
  firstName: string;
  lastName: string;
  country: string;
  parentId: number | null;
  childId: number | null;
  addedUTC: string;
  lastUpdatedUTC?: string;
  disabled: number;
}

export async function startForeignSession(_email: string, _hours = 1): Promise<string | null> {
  return null; // no foreign-session concept; trade history is fetched directly by the adapter
}
export async function endForeignSession(_token: string): Promise<void> {
  /* no-op */
}
export async function fetchChallengeAccounts(_params: { phases?: number[]; status?: number }): Promise<{ data: ChallengeAccountSearchResult[]; total: number }> {
  return { data: [], total: 0 };
}
export async function searchAccountsByEmail(_email: string, _tenantId: string): Promise<ChallengeAccountSearchResult[]> {
  return [];
}
export async function searchAccountsByLogin(_login: string, _tenantId: string): Promise<ChallengeAccountSearchResult[]> {
  return [];
}
export async function getPassedAccountTotal(): Promise<number> {
  return 0;
}
export async function fetchPassedChallengeAccounts(_params: { page?: number; pageSize?: number; search?: string }, _tenantId: string): Promise<{ data: ChallengeAccountSearchResult[]; page: number; pageSize: number; hasMore: boolean; total: number }> {
  const { page = 1, pageSize = 25 } = _params;
  return { data: [], page, pageSize, hasMore: false, total: 0 };
}

// --- Plan name parsing (pure helper, provider-agnostic) ---

// Re-exported for server-side callers; the implementation is deliberately in a
// dependency-free module so client components can import it without pulling
// this facade (and the credential vault behind it) into the browser bundle.
export { parsePlanName } from './plan-name';
