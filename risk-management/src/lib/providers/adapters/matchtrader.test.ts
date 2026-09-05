import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchtraderAdapter, __testing } from './matchtrader';

// Per-tenant config resolution reads from the `connections` table when a
// tenantId is passed; here we fake that lookup so the test can control which
// credentials/host each tenant resolves to without touching Supabase.
// `vi.mock` calls are hoisted above imports by vitest.
vi.mock('../registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../registry')>();
  return {
    ...actual,
    getProviderConfig: (id: Parameters<typeof actual.getProviderConfig>[0], tenantId?: string) => {
      if (tenantId === undefined) return actual.getProviderConfig(id);
      return Promise.resolve({
        id,
        enabled: true,
        apiUrl: 'https://broker-api-demo.match-trader.com',
        apiKey: `key-${tenantId}`,
        // No SYSTEM_UUID here on purpose — forces discovery via GET /v1/offers,
        // which is exactly the call whose result gets cached per tenant.
        extra: {},
      });
    },
  };
});

type Handler = (url: string, init?: RequestInit) => unknown;

function mockFetch(routes: Record<string, Handler>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    // Longest-prefix match so /v1/trading-accounts doesn't shadow /v1/trading-account
    const key = Object.keys(routes)
      .filter((r) => path.split('?')[0] === r || path.startsWith(`${r}?`) || path.startsWith(r))
      .sort((a, b) => b.length - a.length)[0];
    const body = key ? routes[key](url, init) : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
  });
}

beforeEach(() => {
  process.env.PROVIDER_MATCHTRADER_ENABLED = 'true';
  process.env.PROVIDER_MATCHTRADER_API_URL = 'https://broker-api-demo.match-trader.com';
  process.env.PROVIDER_MATCHTRADER_API_KEY = 'key123';
  process.env.PROVIDER_MATCHTRADER_SYSTEM_UUID = 'sys-uuid';
  process.env.PROVIDER_MATCHTRADER_GROUPS = 'prop\\real';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PROVIDER_MATCHTRADER_ENABLED;
});

describe('matchtrader adapter (live)', () => {
  it('maps trading accounts (access → status/canTrade)', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/v1/trading-accounts': () => ({
        content: [
          { login: 1001, email: 'a@x.com', group: 'prop\\real', access: 'FULL', financeInfo: { balance: 10000, equity: 10250, profit: 250 } },
          { login: 1002, email: 'b@x.com', group: 'prop\\real', access: 'TRADING_DISABLED', financeInfo: { balance: 9000, equity: 9000, profit: 0 } },
        ],
        totalElements: 2,
      }),
    }));

    const accounts = await matchtraderAdapter.listAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts[0].login).toBe('1001');
    expect(accounts[0].balance).toBe(10000);
    expect(accounts[0].equity).toBe(10250);
    expect(accounts[0].canTrade).toBe(true);
    expect(accounts[0].status).toBe('active');
    expect(accounts[1].canTrade).toBe(false);
    expect(accounts[1].status).toBe('suspended');
  });

  it('parses string-typed numeric fields in closed positions', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/v1/trading-accounts/trading-data/closed-positions': () => ({
        closedPositions: [
          { id: 'p1', openTime: '2026-06-01T10:00:00Z', openPrice: '1.1000', symbol: 'EURUSD', volume: '1.50', time: '2026-06-01T10:30:00Z', closePrice: '1.1050', commission: '-3.00', swap: '0.00', profit: '75.00', side: 'Buy' },
        ],
      }),
    }));

    const trades = await matchtraderAdapter.getClosedTradeHistory('1001');
    expect(trades).toHaveLength(1);
    expect(trades[0].profit).toBe(75);
    expect(trades[0].sizeNative).toBe(1.5);
    expect(trades[0].openPrice).toBe(1.1);
    expect(trades[0].durationSec).toBe(1800);
    expect(trades[0].symbol).toBe('EURUSD');
  });

  it('suspend enforcement PATCHes access to TRADING_DISABLED', async () => {
    let method = '';
    let captured: any = null;
    vi.stubGlobal('fetch', mockFetch({
      '/v1/trading-account': (_u, init) => {
        method = String(init?.method);
        captured = JSON.parse(String(init?.body));
        return {};
      },
    }));

    const res = await matchtraderAdapter.enforce!('1001', 'suspend');
    expect(res.ok).toBe(true);
    expect(method).toBe('PATCH');
    expect(captured.access).toBe('TRADING_DISABLED');
  });
});

describe('matchtrader per-tenant systemUuid cache', () => {
  const TENANT_A = 'tenant-a';
  const TENANT_B = 'tenant-b';

  beforeEach(() => {
    __testing.systemUuidCache.clear();
  });

  it("never returns tenant A's discovered systemUuid for tenant B (or vice versa)", async () => {
    const offersRequests: string[] = [];
    const tradingAccountsAuth: string[] = [];

    vi.stubGlobal('fetch', mockFetch({
      '/v1/offers': (_u, init) => {
        const key = String((init?.headers as Record<string, string>)?.Authorization);
        offersRequests.push(key);
        // Each tenant's key resolves to its own systemUuid.
        return [{ systemUuid: `sys-${key}` }];
      },
      '/v1/trading-accounts': (_u, init) => {
        const body = JSON.parse(String(init?.body));
        tradingAccountsAuth.push(body.systemUuid);
        return { content: [] };
      },
    }));

    await matchtraderAdapter.listAccounts(TENANT_A);
    await matchtraderAdapter.listAccounts(TENANT_B);

    expect(tradingAccountsAuth).toEqual([`sys-key-${TENANT_A}`, `sys-key-${TENANT_B}`]);
    expect(__testing.systemUuidCache.size).toBe(2);
    expect(__testing.systemUuidCache.get(TENANT_A)).toBe(`sys-key-${TENANT_A}`);
    expect(__testing.systemUuidCache.get(TENANT_B)).toBe(`sys-key-${TENANT_B}`);
    expect(__testing.systemUuidCache.get(TENANT_A)).not.toBe(__testing.systemUuidCache.get(TENANT_B));

    // Tenant A again: cache hit, no new /v1/offers call, and still A's uuid.
    const offersCallsBefore = offersRequests.length;
    tradingAccountsAuth.length = 0;
    await matchtraderAdapter.listAccounts(TENANT_A);
    expect(offersRequests).toHaveLength(offersCallsBefore);
    expect(tradingAccountsAuth).toEqual([`sys-key-${TENANT_A}`]);
  });
});
