import { DEMO_MODE } from '@/lib/demo';
import { FOREX_ACCOUNTS, type MockAccount } from '@/lib/mock/dataset.forex';
import { FUTURES_ACCOUNTS } from '@/lib/mock/dataset.futures';
import { PROVIDER_META, getProviderConfig } from '../registry';
import { NotConfiguredError, type EnforcementAction, type TradingProvider } from '../interface';
import {
  VIOLATION_LABELS,
  severityFromDeduction,
  type NormalizedAccount,
  type NormalizedTrade,
  type NormalizedViolation,
  type ProviderId,
} from '../types';

/**
 * Shared adapter factory. Every platform adapter is identical in structure —
 * it maps the platform's native API onto the normalized model. The only real
 * differences (auth, transport, endpoints) are documented per-adapter and live
 * in the `liveXxx` TODO blocks. Until a provider is configured with real
 * credentials (or while DEMO_MODE is on), methods return mock data so the demo
 * and the integration scaffolding share one code path.
 */

function mockAccountsFor(id: ProviderId): MockAccount[] {
  const assetClass = PROVIDER_META[id].assetClass;
  const pool = assetClass === 'futures' ? FUTURES_ACCOUNTS : FOREX_ACCOUNTS;
  return pool.filter((a) => a.provider === id);
}

function toNormalizedAccount(id: ProviderId, a: MockAccount): NormalizedAccount {
  const meta = PROVIDER_META[id];
  const sizeUnit = meta.assetClass === 'futures' ? 'contracts' : 'lots';
  const totalDed = Object.values(a.deductionBreakdown).reduce((s, v) => s + v, 0);
  return {
    id: a.accountId,
    provider: id,
    providerLabel: meta.label,
    assetClass: meta.assetClass,
    login: a.login,
    email: a.email,
    firstName: a.firstName,
    lastName: a.lastName,
    country: a.country,
    kycStatus: a.kycStatus,
    isBlackListed: a.isBlackListed,
    plan: a.plan,
    phase: 'funded',
    status: a.canTrade === false ? 'breached' : totalDed > 0 ? 'restricted' : 'active',
    canTrade: a.canTrade ?? true,
    startingBalance: a.startingBalance,
    balance: a.balance,
    equity: a.balance,
    totalPnL: a.totalPnL,
    maxDailyLossPct: a.maxDailyLossPct ?? 0,
    maxTrailingDrawdownPct: a.maxTrailingDrawdownPct ?? 0,
    maxPositionSize: a.maxPositionSize ?? 0,
    sizeUnit,
    banNewsTrading: Boolean(a.banNewsTrading),
    banHFT: Boolean(a.banHFT),
    banMartingale: Boolean(a.banMTGL),
    tradedDays: a.tradedDays,
  };
}

function toNormalizedViolations(id: ProviderId, a: MockAccount): NormalizedViolation[] {
  const meta = PROVIDER_META[id];
  return Object.entries(a.deductionBreakdown)
    .filter(([, amt]) => amt > 0)
    .map(([type, amt]) => ({
      id: `${a.accountId}-${type}`,
      accountId: a.accountId,
      type: type as NormalizedViolation['type'],
      label: (VIOLATION_LABELS as Record<string, string>)[type] || type,
      assetClass: meta.assetClass,
      severity: severityFromDeduction(amt),
      detectedAt: new Date().toISOString(),
      description: `${(VIOLATION_LABELS as Record<string, string>)[type] || type} on ${meta.label} account ${a.login}.`,
      deductionAmount: amt,
      affectedTradeIds: [],
      status: 'detected' as const,
    }));
}

/** The live (real-API) half of an adapter. Any method left undefined falls
 *  back to `NotConfiguredError` when the provider is configured but that
 *  capability isn't implemented yet. */
export type LiveImpl = Partial<
  Pick<
    TradingProvider,
    | 'listAccounts'
    | 'getAccount'
    | 'getUser'
    | 'getBalanceEquity'
    | 'getOpenPositions'
    | 'getClosedTradeHistory'
    | 'getPayouts'
    | 'getRiskViolations'
    | 'enforce'
  >
>;

export interface AdapterOptions {
  /** Provider supports enforcement actions (close/suspend/flatten). */
  canEnforce?: boolean;
  /** Real-API implementation, used when the provider is configured & not in demo. */
  live?: LiveImpl;
}

export function createAdapter(id: ProviderId, opts: AdapterOptions = {}): TradingProvider {
  const meta = PROVIDER_META[id];

  // `tenantId` undefined => legacy env-based global config (unchanged
  // behavior for callers that predate per-tenant connections). Supplied =>
  // resolve from that tenant's `connections` row, falling back to env if the
  // tenant hasn't provisioned one yet.
  async function isEnabled(tenantId?: string): Promise<boolean> {
    const cfg = tenantId === undefined ? getProviderConfig(id) : await getProviderConfig(id, tenantId);
    return cfg.enabled;
  }
  async function stub(tenantId?: string): Promise<boolean> {
    return DEMO_MODE || !(await isEnabled(tenantId));
  }

  const live = opts.live ?? {};

  const adapter: TradingProvider = {
    meta,
    isConfigured: (tenantId?: string) => isEnabled(tenantId),

    async listAccounts(tenantId) {
      if (await stub(tenantId)) return mockAccountsFor(id).map((a) => toNormalizedAccount(id, a));
      if (live.listAccounts) return live.listAccounts(tenantId);
      throw new NotConfiguredError(id);
    },

    async getAccount(accountId, tenantId) {
      if (await stub(tenantId)) {
        const a = mockAccountsFor(id).find((x) => x.accountId === accountId || x.login === accountId);
        return a ? toNormalizedAccount(id, a) : null;
      }
      if (live.getAccount) return live.getAccount(accountId, tenantId);
      // Fall back to a full list scan when the adapter has no single-account call.
      if (live.listAccounts) {
        const all = await live.listAccounts(tenantId);
        return all.find((a) => a.id === accountId || a.login === accountId) ?? null;
      }
      throw new NotConfiguredError(id);
    },

    async getUser(userId, tenantId) {
      if (await stub(tenantId)) {
        const a = mockAccountsFor(id).find((x) => x.accountId === userId || x.login === userId);
        if (!a) return null;
        return {
          userId: a.accountId,
          email: a.email,
          firstName: a.firstName,
          lastName: a.lastName,
          country: a.country,
          kycStatus: a.kycStatus,
          isBlackListed: a.isBlackListed,
        };
      }
      if (live.getUser) return live.getUser(userId, tenantId);
      throw new NotConfiguredError(id);
    },

    async getBalanceEquity(accountId, tenantId) {
      if (await stub(tenantId)) {
        const a = mockAccountsFor(id).find((x) => x.accountId === accountId);
        return a ? { balance: a.balance, equity: a.balance } : null;
      }
      if (live.getBalanceEquity) return live.getBalanceEquity(accountId, tenantId);
      throw new NotConfiguredError(id);
    },

    async getOpenPositions(accountId, tenantId) {
      if (await stub(tenantId)) return [] as NormalizedTrade[];
      if (live.getOpenPositions) return live.getOpenPositions(accountId, tenantId);
      throw new NotConfiguredError(id);
    },

    async getClosedTradeHistory(accountId, tenantId) {
      if (await stub(tenantId)) return [] as NormalizedTrade[];
      if (live.getClosedTradeHistory) return live.getClosedTradeHistory(accountId, tenantId);
      throw new NotConfiguredError(id);
    },

    async getPayouts(tenantId) {
      if (await stub(tenantId))
        return mockAccountsFor(id)
          .filter((a) => a.payoutAmount > 0)
          .map((a) => ({
            id: `PO-${a.accountId}`,
            accountId: a.accountId,
            login: a.login,
            email: a.email,
            amount: a.payoutAmount,
            clientAmount: a.payoutAmount,
            status: 'Pending',
            requestedAt: new Date().toISOString(),
          }));
      if (live.getPayouts) return live.getPayouts(tenantId);
      throw new NotConfiguredError(id);
    },

    async getRiskViolations(accountId, tenantId) {
      if (await stub(tenantId)) {
        const a = mockAccountsFor(id).find((x) => x.accountId === accountId);
        return a ? toNormalizedViolations(id, a) : [];
      }
      if (live.getRiskViolations) return live.getRiskViolations(accountId, tenantId);
      throw new NotConfiguredError(id);
    },
  };

  if (opts.canEnforce) {
    adapter.enforce = async (accountId: string, action: EnforcementAction, tenantId?: string) => {
      if (await stub(tenantId))
        return { ok: true, message: `Demo: ${action} on ${meta.label} account ${accountId} (no live call).` };
      if (live.enforce) return live.enforce(accountId, action, tenantId);
      throw new NotConfiguredError(id);
    };
  }

  return adapter;
}

// Re-export normalized-mapping helpers + labels so hand-written adapters can
// build the same shapes the mock path produces.
export { severityFromDeduction, VIOLATION_LABELS };
export type { NormalizedAccount, NormalizedTrade, NormalizedViolation };
