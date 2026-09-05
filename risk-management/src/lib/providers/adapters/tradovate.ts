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
 * Tradovate — Futures, manager. (NinjaTrader's cloud API.)
 *
 * Verified against partner.tradovate.com (2026-07). Base host is demo or live
 * per PROVIDER_TRADOVATE_ENV; auth is a 90-minute bearer token cached
 * per-tenant and renewed on demand. Enforcement uses accountRiskStatus admin
 * actions + order/liquidateposition.
 *
 * Env (PROVIDER_TRADOVATE_*):
 *   ENABLED=true, ENV=demo|live (or API_URL to override the host),
 *   NAME, PASSWORD, APP_ID, APP_VERSION, CID, SEC, DEVICE_ID
 * Per-tenant equivalent lives in `connections` (src/lib/connections/store.ts),
 * resolved via getProviderConfig('tradovate', tenantId).
 *
 * Futures violations (daily-loss / trailing-drawdown / position-limit) are
 * computed by the platform's futures risk engine from balance + positions —
 * getRiskViolations returns [] (the API exposes auto-liq CONFIG, not breaches).
 */

interface TradovateConfig {
  baseUrl: string;
  name: string;
  password: string;
  appId?: string;
  appVersion?: string;
  cid?: string;
  sec?: string;
  deviceId?: string;
}

async function config(tenantId?: string): Promise<TradovateConfig> {
  const c = tenantId === undefined ? getProviderConfig('tradovate') : await getProviderConfig('tradovate', tenantId);
  const env = (c.extra.ENV || 'demo').toLowerCase();
  const host = c.apiUrl || `https://${env === 'live' ? 'live' : 'demo'}.tradovateapi.com/v1`;
  return {
    baseUrl: host.replace(/\/$/, ''),
    name: c.extra.NAME || '',
    password: c.extra.PASSWORD || '',
    appId: c.extra.APP_ID,
    appVersion: c.extra.APP_VERSION,
    cid: c.extra.CID,
    sec: c.extra.SEC,
    deviceId: c.extra.DEVICE_ID,
  };
}

// --- Token cache, keyed per tenant (90-min lifetime, renewed ~15 min early) ---
//
// This used to be a single module-scoped variable shared by every request in
// the process. Under shared tenancy that is a straight-up credential leak:
// tenant A authenticates, its bearer token is cached, and the very next
// request — for tenant B — would reuse tenant A's token because nothing
// distinguished the two callers. Keying the cache on tenantId (falling back
// to a fixed '__env__' slot only for the legacy no-tenant call path) makes
// that leak structurally impossible: there is no way to read tenant B's
// token out of a Map keyed by tenant A's id.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function cacheKey(tenantId?: string): string {
  return tenantId ?? '__env__';
}

async function authToken(tenantId?: string): Promise<string> {
  const key = cacheKey(tenantId);
  const now = Date.now();
  const cached = tokenCache.get(key);
  if (cached && now < cached.expiresAt - 15 * 60_000) {
    return cached.token;
  }
  const cfg = await config(tenantId);
  const res = await fetchJson<{ accessToken?: string; expirationTime?: string; errorText?: string }>(
    `${cfg.baseUrl}/auth/accesstokenrequest`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: cfg.name,
        password: cfg.password,
        appId: cfg.appId,
        appVersion: cfg.appVersion,
        cid: cfg.cid,
        sec: cfg.sec,
        deviceId: cfg.deviceId,
      }),
    }
  );
  if (!res.accessToken) {
    throw new Error(`Tradovate auth failed: ${res.errorText || 'no accessToken returned'}`);
  }
  const expiresAt = res.expirationTime ? Date.parse(res.expirationTime) : now + 90 * 60_000;
  tokenCache.set(key, { token: res.accessToken, expiresAt });
  return res.accessToken;
}

type PenaltyMeta = { 'p-ticket'?: string; 'p-time'?: number; 'p-captcha'?: boolean };

/** Authenticated GET/POST with one p-ticket retry (Tradovate's endpoint throttle). */
async function api<T>(path: string, init?: { method?: string; body?: unknown }, tenantId?: string): Promise<T> {
  const cfg = await config(tenantId);
  const token = await authToken(tenantId);
  const isPost = init?.method === 'POST' || init?.body != null;
  const doCall = (extraBody?: Record<string, unknown>) =>
    fetchJson<T & PenaltyMeta>(`${cfg.baseUrl}${path}`, {
      method: isPost ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(isPost ? { 'Content-Type': 'application/json' } : {}),
      },
      body: isPost ? JSON.stringify({ ...(init?.body as object), ...extraBody }) : undefined,
    });

  const first = await doCall();
  // Endpoint throttle: 200 with a p-ticket → wait p-time, retry once with the ticket.
  if (first && typeof first === 'object' && first['p-ticket']) {
    if (first['p-captcha']) throw new Error('Tradovate rate limit requires captcha (not retriable server-side)');
    const waitMs = Math.min((first['p-time'] || 1) * 1000, 10_000);
    await new Promise((r) => setTimeout(r, waitMs));
    return doCall({ 'p-ticket': first['p-ticket'] }) as Promise<T>;
  }
  return first as T;
}

// --- Native shapes (subset of the verified schema) ---
interface TvAccount {
  id: number; name: string; userId: number; accountType?: string;
  restricted?: boolean; closed?: boolean; readonly?: boolean; futuresDisabled?: boolean;
  autoLiqProfileId?: number; evaluationSize?: number; timestamp?: string;
}
interface TvCashSnapshot {
  totalCashValue?: number; netLiq?: number; openPnL?: number; realizedPnL?: number; totalPnL?: number;
}
interface TvUser { id: number; name: string; email?: string; status?: string }
interface TvPosition { id: number; accountId: number; contractId: number; netPos: number; netPrice?: number; timestamp?: string }

async function cashSnapshot(accountId: number, tenantId?: string): Promise<TvCashSnapshot> {
  try {
    return await api<TvCashSnapshot>(
      '/cashBalance/getcashbalancesnapshot',
      { method: 'POST', body: { accountId } },
      tenantId
    );
  } catch {
    return {};
  }
}

// Contract id -> display name. Not a credential — the same futures contract
// (e.g. "ESZ6") means the same thing for every tenant, so this stays a single
// shared cache rather than per-tenant.
const contractNameCache = new Map<number, string>();
async function contractName(contractId: number, tenantId?: string): Promise<string> {
  if (contractNameCache.has(contractId)) return contractNameCache.get(contractId)!;
  try {
    const c = await api<{ name?: string }>(`/contract/item?id=${contractId}`, undefined, tenantId);
    const name = c?.name || String(contractId);
    contractNameCache.set(contractId, name);
    return name;
  } catch {
    return String(contractId);
  }
}

function accountStatus(a: TvAccount): NormalizedAccount['status'] {
  if (a.closed) return 'closed';
  if (a.restricted || a.readonly || a.futuresDisabled) return 'restricted';
  return 'active';
}

async function toNormalizedAccount(
  a: TvAccount,
  users: Map<number, TvUser>,
  tenantId?: string
): Promise<NormalizedAccount> {
  const snap = await cashSnapshot(a.id, tenantId);
  const balance = snap.totalCashValue ?? 0;
  const equity = snap.netLiq ?? balance + (snap.openPnL ?? 0);
  const u = users.get(a.userId);
  return {
    id: String(a.id),
    provider: 'tradovate',
    providerLabel: 'Tradovate',
    assetClass: 'futures',
    login: a.name,
    email: u?.email || '',
    firstName: '',
    lastName: '',
    country: '',
    kycStatus: u?.status === 'Active' ? 'Verified' : (u?.status || 'Unknown'),
    isBlackListed: u?.status === 'Closed',
    plan: a.evaluationSize ? `Eval ${a.evaluationSize}` : (a.accountType || ''),
    phase: 'funded',
    status: accountStatus(a),
    canTrade: !a.closed && !a.restricted && !a.readonly && !a.futuresDisabled,
    startingBalance: a.evaluationSize ?? 0,
    balance,
    equity,
    totalPnL: snap.totalPnL ?? 0,
    maxDailyLossPct: 0,
    maxTrailingDrawdownPct: 0,
    maxPositionSize: 0,
    sizeUnit: 'contracts',
    banNewsTrading: false,
    banHFT: false,
    banMartingale: false,
    tradedDays: 0,
  };
}

const live: LiveImpl = {
  async listAccounts(tenantId) {
    const [accounts, users] = await Promise.all([
      api<TvAccount[]>('/account/list', undefined, tenantId),
      api<TvUser[]>('/user/list', undefined, tenantId).catch(() => [] as TvUser[]),
    ]);
    const userMap = new Map(users.map((u) => [u.id, u]));
    const normalized = await mapConcurrent(accounts, (a) => toNormalizedAccount(a, userMap, tenantId), 5);
    return normalized.filter((a): a is NormalizedAccount => a !== null);
  },

  async getAccount(accountId, tenantId) {
    const accounts = await api<TvAccount[]>('/account/list', undefined, tenantId);
    const a = accounts.find((x) => String(x.id) === accountId || x.name === accountId);
    if (!a) return null;
    const users = await api<TvUser[]>('/user/list', undefined, tenantId).catch(() => [] as TvUser[]);
    return toNormalizedAccount(a, new Map(users.map((u) => [u.id, u])), tenantId);
  },

  async getUser(userId, tenantId): Promise<NormalizedUser | null> {
    const users = await api<TvUser[]>('/user/list', undefined, tenantId);
    const u = users.find((x) => String(x.id) === userId || x.name === userId);
    if (!u) return null;
    return {
      userId: String(u.id),
      email: u.email || '',
      firstName: '',
      lastName: '',
      country: '',
      kycStatus: u.status === 'Active' ? 'Verified' : (u.status || 'Unknown'),
      isBlackListed: u.status === 'Closed',
    };
  },

  async getBalanceEquity(accountId, tenantId) {
    const snap = await cashSnapshot(Number(accountId), tenantId);
    if (snap.totalCashValue == null && snap.netLiq == null) return null;
    const balance = snap.totalCashValue ?? 0;
    return { balance, equity: snap.netLiq ?? balance + (snap.openPnL ?? 0) };
  },

  async getOpenPositions(accountId, tenantId): Promise<NormalizedTrade[]> {
    const positions = await api<TvPosition[]>('/position/list', undefined, tenantId);
    const mine = positions.filter((p) => String(p.accountId) === accountId && p.netPos !== 0);
    return Promise.all(
      mine.map(async (p) => ({
        id: String(p.id),
        accountId,
        provider: 'tradovate' as const,
        assetClass: 'futures' as const,
        symbol: await contractName(p.contractId, tenantId),
        side: p.netPos > 0 ? ('Buy' as const) : ('Sell' as const),
        sizeNative: Math.abs(p.netPos),
        sizeUnit: 'contracts' as const,
        notionalUSD: 0,
        openTime: p.timestamp || '',
        closeTime: '',
        openPrice: p.netPrice ?? 0,
        closePrice: 0,
        durationSec: 0,
        profit: 0,
        commission: 0,
        swap: 0,
      }))
    );
  },

  async getClosedTradeHistory(): Promise<NormalizedTrade[]> {
    // /fill/list is not scopable to a single account from the REST list
    // endpoint alone (fills join to accounts only via their parent orders),
    // so we do not attribute fills here. Futures monitoring uses balance +
    // open positions; closed round-trips would need order→fill joining.
    return [];
  },

  async getPayouts() {
    // Tradovate is a trading platform, not a payout processor — no payout queue.
    return [];
  },

  async getRiskViolations(): Promise<NormalizedViolation[]> {
    // Auto-liq settings are config, not breaches; the futures engine computes
    // daily-loss / trailing-drawdown / position-limit from balance + positions.
    return [];
  },

  async enforce(accountId: string, action: EnforcementAction, tenantId?: string) {
    const id = Number(accountId);
    try {
      if (action === 'flatten') {
        const positions = await api<TvPosition[]>('/position/list', undefined, tenantId);
        const open = positions.filter((p) => String(p.accountId) === accountId && p.netPos !== 0);
        for (const p of open) {
          await api(
            '/order/liquidateposition',
            { method: 'POST', body: { accountId: id, contractId: p.contractId, admin: true } },
            tenantId
          );
        }
        return { ok: true, message: `Flattened ${open.length} position(s) on Tradovate account ${accountId}.` };
      }
      const adminAction =
        action === 'suspend' ? 'LockTradingImmediately'
        : action === 'restrict' ? 'LiquidateOnlyModeImmediately'
        : 'Normal'; // activate
      const res = await api<{ errorText?: string }>(
        '/accountRiskStatus/setadminautoliqaction',
        {
          method: 'POST',
          body: {
            accountId: id,
            adminAction,
            adminActionReasonCode: 'Other',
            adminActionReason: `Risk platform enforcement: ${action}`,
          },
        },
        tenantId
      );
      if (res?.errorText) return { ok: false, message: res.errorText };
      return { ok: true, message: `Set Tradovate account ${accountId} to ${adminAction}.` };
    } catch (err) {
      const msg = err instanceof ProviderHttpError ? `HTTP ${err.status}` : err instanceof Error ? err.message : 'Unknown error';
      return { ok: false, message: `Tradovate enforce failed: ${msg}` };
    }
  },
};

export const tradovateAdapter = createAdapter('tradovate', { canEnforce: true, live });

// Test-only escape hatch: the module-scoped token cache is exactly the thing
// this refactor exists to make safe across tenants, so the test suite needs
// to inspect it directly rather than through timing.
export const __testing = { tokenCache, cacheKey };
