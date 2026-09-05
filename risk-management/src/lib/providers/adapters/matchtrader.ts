import { createAdapter, type LiveImpl } from './base';
import { fetchJson, mapConcurrent, ProviderHttpError } from './http';
import { getProviderConfig } from '../registry';
import type {
  NormalizedAccount,
  NormalizedTrade,
  NormalizedUser,
  NormalizedViolation,
} from '../types';
import type { EnforcementAction } from '../interface';

/**
 * MatchTrader (Match-Trade Technologies) — Forex, manager. Broker API (REST).
 *
 * Verified against app.theneo.io/match-trade/broker-api (2026-07):
 * - Per-deployment host (PROVIDER_MATCHTRADER_API_URL), e.g.
 *   https://broker-api-demo.match-trader.com
 * - Auth: raw token in the `Authorization` header (no `Bearer` for REST — this
 *   matches every integration-guide curl; the token encodes partnerID).
 * - systemUuid is required on trading-data calls; from PROVIDER_MATCHTRADER_SYSTEM_UUID
 *   or discovered via GET /v1/offers, cached per tenant.
 * - Enforcement kill switch: PATCH /v1/trading-account { access }.
 *
 * The Broker API exposes raw account/finance/trade data (no server-computed
 * prop violations — that lives in Match-Trade's prop-edge gRPC), so
 * getRiskViolations returns [] and the forex engine derives breaches from
 * trades. Starting-balance / challenge metadata is likewise not in the Broker
 * API, so startingBalance is 0 here (set it from your prop config if needed).
 *
 * Env (PROVIDER_MATCHTRADER_*):
 *   ENABLED=true, API_URL=<host>, API_KEY=<token>, SYSTEM_UUID=<uuid>,
 *   GROUPS=<comma-separated account groups to enumerate>
 * Per-tenant equivalent lives in `connections` (src/lib/connections/store.ts),
 * resolved via getProviderConfig('matchtrader', tenantId).
 */

interface MtConfig {
  baseUrl: string;
  token: string;
  systemUuid?: string;
  groups: string[];
}

async function config(tenantId?: string): Promise<MtConfig> {
  const c = tenantId === undefined ? getProviderConfig('matchtrader') : await getProviderConfig('matchtrader', tenantId);
  return {
    baseUrl: (c.apiUrl || '').replace(/\/$/, ''),
    token: c.apiKey || '',
    systemUuid: c.extra.SYSTEM_UUID,
    groups: (c.extra.GROUPS || '').split(',').map((g) => g.trim()).filter(Boolean),
  };
}

function authHeaders(cfg: MtConfig): Record<string, string> {
  // REST integration examples send the raw key (no "Bearer" prefix).
  return { Authorization: cfg.token };
}

// --- systemUuid cache, keyed per tenant ---
//
// Same failure mode as Tradovate's token cache: a single module-scoped
// `cachedSystemUuid` would let tenant A's discovered trading-server UUID leak
// into tenant B's calls (wrong systemUuid means wrong broker's accounts).
// Keying on tenantId (or '__env__' for the legacy no-tenant path) removes
// that possibility entirely.
const systemUuidCache = new Map<string, string>();

function cacheKey(tenantId?: string): string {
  return tenantId ?? '__env__';
}

async function systemUuid(cfg: MtConfig, tenantId?: string): Promise<string> {
  if (cfg.systemUuid) return cfg.systemUuid;
  const key = cacheKey(tenantId);
  const cached = systemUuidCache.get(key);
  if (cached) return cached;
  const offers = await fetchJson<Array<{ systemUuid?: string }>>(`${cfg.baseUrl}/v1/offers`, {
    headers: authHeaders(cfg),
  });
  const uuid = offers?.[0]?.systemUuid;
  if (!uuid) throw new Error('MatchTrader: could not resolve systemUuid (set PROVIDER_MATCHTRADER_SYSTEM_UUID)');
  systemUuidCache.set(key, uuid);
  return uuid;
}

// --- Native shapes (subset of the verified schema) ---
type MtAccess = 'FULL' | 'CLOSE_ONLY' | 'TRADING_DISABLED' | 'TRADING_AND_LOGIN_DISABLED' | 'LOCKED_CLOSE_ONLY' | 'UNSPECIFIED';
interface MtFinance {
  balance?: number; equity?: number; profit?: number; netProfit?: number;
  margin?: number; freeMargin?: number; marginLevel?: number; credit?: number; currency?: string;
}
interface MtTradingAccount {
  login: number; email?: string; group?: string; leverage?: number;
  accountType?: 'DEMO' | 'REAL'; access?: MtAccess; financeInfo?: MtFinance;
}
interface MtCrmAccount {
  uuid: string; email?: string; verificationStatus?: string;
  personalDetails?: { firstname?: string; lastname?: string; citizenship?: string; passport?: { country?: string } };
  addressDetails?: { country?: string };
}
interface MtClosedPosition {
  id: string; openTime: string; openPrice: string; symbol: string; alias?: string; volume: string;
  time: string; closePrice: string; commission: string; swap: string; profit: string; side: 'Buy' | 'Sell';
  reason?: string; comment?: string;
}
interface MtOpenPosition {
  id: string; symbol: string; volume: number; side: 'Buy' | 'Sell'; openTime: string; openPrice: number;
  swap?: number; profit?: number; commission?: number; currentPrice?: number;
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function statusFromAccess(access?: MtAccess): { status: NormalizedAccount['status']; canTrade: boolean } {
  switch (access) {
    case 'FULL': return { status: 'active', canTrade: true };
    case 'CLOSE_ONLY':
    case 'LOCKED_CLOSE_ONLY': return { status: 'restricted', canTrade: false };
    case 'TRADING_DISABLED':
    case 'TRADING_AND_LOGIN_DISABLED': return { status: 'suspended', canTrade: false };
    default: return { status: 'active', canTrade: true };
  }
}

function toNormalizedAccount(t: MtTradingAccount): NormalizedAccount {
  const fin = t.financeInfo || {};
  const { status, canTrade } = statusFromAccess(t.access);
  return {
    id: String(t.login),
    provider: 'matchtrader',
    providerLabel: 'MatchTrader',
    assetClass: 'forex',
    login: String(t.login),
    email: t.email || '',
    firstName: '',
    lastName: '',
    country: '',
    kycStatus: 'Unknown',
    isBlackListed: false,
    plan: t.group || '',
    phase: 'funded',
    status,
    canTrade,
    // Broker API has no challenge metadata — starting balance unknown here.
    startingBalance: 0,
    balance: num(fin.balance),
    equity: num(fin.equity),
    totalPnL: num(fin.profit),
    maxDailyLossPct: 0,
    maxTrailingDrawdownPct: 0,
    maxPositionSize: 0,
    sizeUnit: 'lots',
    banNewsTrading: false,
    banHFT: false,
    banMartingale: false,
    tradedDays: 0,
  };
}

async function tradingData<T>(
  cfg: MtConfig,
  path: string,
  body: Record<string, unknown>,
  tenantId?: string
): Promise<T> {
  const uuid = await systemUuid(cfg, tenantId);
  return fetchJson<T>(`${cfg.baseUrl}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemUuid: uuid, ...body }),
  });
}

const live: LiveImpl = {
  async listAccounts(tenantId) {
    const cfg = await config(tenantId);
    const uuid = await systemUuid(cfg, tenantId);
    const res = await fetchJson<{ content?: MtTradingAccount[] }>(`${cfg.baseUrl}/v1/trading-accounts`, {
      method: 'POST',
      headers: { ...authHeaders(cfg), 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemUuid: uuid, groups: cfg.groups, includeBlocked: true, includeLocked: true }),
    });
    return (res.content || []).map(toNormalizedAccount);
  },

  async getAccount(accountId, tenantId) {
    const cfg = await config(tenantId);
    const uuid = await systemUuid(cfg, tenantId);
    try {
      const t = await fetchJson<MtTradingAccount & { accountInfo?: { email?: string } }>(
        `${cfg.baseUrl}/v1/trading-account?systemUuid=${encodeURIComponent(uuid)}&login=${encodeURIComponent(accountId)}`,
        { headers: authHeaders(cfg) }
      );
      const acct = toNormalizedAccount(t);
      if (!acct.email && t.accountInfo?.email) acct.email = t.accountInfo.email;
      return acct;
    } catch (err) {
      if (err instanceof ProviderHttpError && err.status === 404) return null;
      throw err;
    }
  },

  async getUser(userId, tenantId): Promise<NormalizedUser | null> {
    const cfg = await config(tenantId);
    const isEmail = userId.includes('@');
    const url = isEmail
      ? `${cfg.baseUrl}/v1/accounts/by-email/${encodeURIComponent(userId)}`
      : `${cfg.baseUrl}/v1/accounts/${encodeURIComponent(userId)}`;
    try {
      const a = await fetchJson<MtCrmAccount>(url, { headers: authHeaders(cfg) });
      const pd = a.personalDetails || {};
      return {
        userId: a.uuid,
        email: a.email || (isEmail ? userId : ''),
        firstName: pd.firstname || '',
        lastName: pd.lastname || '',
        country: a.addressDetails?.country || pd.passport?.country || pd.citizenship || '',
        kycStatus: a.verificationStatus === 'VERIFIED' ? 'Verified' : (a.verificationStatus || 'Unknown'),
        isBlackListed: a.verificationStatus === 'BLOCKED',
      };
    } catch (err) {
      if (err instanceof ProviderHttpError && err.status === 404) return null;
      throw err;
    }
  },

  async getBalanceEquity(accountId, tenantId) {
    const acct = await live.getAccount!(accountId, tenantId);
    return acct ? { balance: acct.balance, equity: acct.equity } : null;
  },

  async getOpenPositions(accountId, tenantId): Promise<NormalizedTrade[]> {
    const cfg = await config(tenantId);
    const rows = await tradingData<Array<{ login: number; positions?: MtOpenPosition[] }>>(
      cfg,
      '/v1/trading-accounts/trading-data/open-positions',
      { logins: [Number(accountId)] },
      tenantId
    );
    const positions = rows.find((r) => String(r.login) === accountId)?.positions || [];
    return positions.map((p) => ({
      id: p.id,
      accountId,
      provider: 'matchtrader' as const,
      assetClass: 'forex' as const,
      symbol: p.symbol,
      side: p.side,
      sizeNative: p.volume,
      sizeUnit: 'lots' as const,
      notionalUSD: 0,
      openTime: p.openTime,
      closeTime: '',
      openPrice: p.openPrice,
      closePrice: p.currentPrice ?? 0,
      durationSec: 0,
      profit: p.profit ?? 0,
      commission: p.commission ?? 0,
      swap: p.swap ?? 0,
    }));
  },

  async getClosedTradeHistory(accountId, tenantId): Promise<NormalizedTrade[]> {
    const cfg = await config(tenantId);
    const to = new Date();
    const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
    const res = await tradingData<{ closedPositions?: MtClosedPosition[] }>(
      cfg,
      '/v1/trading-accounts/trading-data/closed-positions',
      { logins: [Number(accountId)], from: from.toISOString(), to: to.toISOString(), limit: 1000 },
      tenantId
    );
    return (res.closedPositions || []).map((c) => {
      const openMs = Date.parse(c.openTime);
      const closeMs = Date.parse(c.time);
      return {
        id: c.id,
        accountId,
        provider: 'matchtrader' as const,
        assetClass: 'forex' as const,
        symbol: c.symbol,
        side: c.side,
        sizeNative: num(c.volume),
        sizeUnit: 'lots' as const,
        notionalUSD: 0,
        openTime: c.openTime,
        closeTime: c.time,
        openPrice: num(c.openPrice),
        closePrice: num(c.closePrice),
        durationSec: Number.isFinite(openMs) && Number.isFinite(closeMs) ? Math.max(0, Math.round((closeMs - openMs) / 1000)) : 0,
        profit: num(c.profit),
        commission: num(c.commission),
        swap: num(c.swap),
      };
    });
  },

  async getPayouts() {
    // Broker API has no payout-request queue (payouts run through the firm's
    // CRM / payout processor, not the trading platform).
    return [];
  },

  async getRiskViolations(): Promise<NormalizedViolation[]> {
    // No server-computed violations in the Broker REST API — the forex engine
    // derives breaches from getClosedTradeHistory.
    return [];
  },

  async enforce(accountId: string, action: EnforcementAction, tenantId?: string) {
    const cfg = await config(tenantId);
    try {
      const uuid = await systemUuid(cfg, tenantId);
      const patchAccess = async (access: MtAccess) =>
        fetchJson(`${cfg.baseUrl}/v1/trading-account?systemUuid=${encodeURIComponent(uuid)}&login=${encodeURIComponent(accountId)}`, {
          method: 'PATCH',
          headers: { ...authHeaders(cfg), 'Content-Type': 'application/json' },
          body: JSON.stringify({ access }),
        });

      if (action === 'flatten') {
        await tradingData(cfg, '/v1/trading-accounts/close-all-positions', { logins: [Number(accountId)] }, tenantId).catch(() => {});
        await patchAccess('CLOSE_ONLY');
        return { ok: true, message: `MatchTrader account ${accountId} set CLOSE_ONLY and positions close requested.` };
      }
      const access: MtAccess =
        action === 'suspend' ? 'TRADING_DISABLED'
        : action === 'restrict' ? 'CLOSE_ONLY'
        : 'FULL'; // activate
      await patchAccess(access);
      return { ok: true, message: `Set MatchTrader account ${accountId} access to ${access}.` };
    } catch (err) {
      const msg = err instanceof ProviderHttpError ? `HTTP ${err.status}` : err instanceof Error ? err.message : 'Unknown error';
      return { ok: false, message: `MatchTrader enforce failed: ${msg}` };
    }
  },
};

export const matchtraderAdapter = createAdapter('matchtrader', { canEnforce: true, live });

// Test-only escape hatch — see the analogous export in tradovate.ts.
export const __testing = { systemUuidCache, cacheKey };
