import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tradovateAdapter, __testing } from './tradovate';

// Per-tenant config resolution reads from the `connections` table when a
// tenantId is passed; here we fake that lookup so the test can control which
// credentials each tenant resolves to without touching Supabase. `vi.mock`
// calls are hoisted above imports by vitest, so this applies regardless of
// where it's written relative to the import above.
vi.mock('../registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../registry')>();
  return {
    ...actual,
    getProviderConfig: (id: Parameters<typeof actual.getProviderConfig>[0], tenantId?: string) => {
      if (tenantId === undefined) return actual.getProviderConfig(id);
      return Promise.resolve({
        id,
        enabled: true,
        apiUrl: undefined,
        apiKey: undefined,
        extra: { NAME: `user-${tenantId}`, PASSWORD: `pass-${tenantId}`, ENV: 'demo' },
      });
    },
  };
});

type Handler = (url: string, init?: RequestInit) => unknown;

function mockFetch(routes: Record<string, Handler>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const key = Object.keys(routes).find((r) => path.startsWith(r));
    const body = key ? routes[key](url, init) : {};
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    } as Response;
  });
}

beforeEach(() => {
  process.env.PROVIDER_TRADOVATE_ENABLED = 'true';
  process.env.PROVIDER_TRADOVATE_ENV = 'demo';
  process.env.PROVIDER_TRADOVATE_NAME = 'u';
  process.env.PROVIDER_TRADOVATE_PASSWORD = 'p';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PROVIDER_TRADOVATE_ENABLED;
});

describe('tradovate adapter (live)', () => {
  it('maps account + cash snapshot into a NormalizedAccount', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/v1/auth/accesstokenrequest': () => ({ accessToken: 'tok', expirationTime: new Date(Date.now() + 3600_000).toISOString() }),
      '/v1/account/list': () => [{ id: 42, name: 'DEMO42', userId: 7, evaluationSize: 50000, closed: false, restricted: false }],
      '/v1/user/list': () => [{ id: 7, name: 'trader', email: 't@x.com', status: 'Active' }],
      '/v1/cashBalance/getcashbalancesnapshot': () => ({ totalCashValue: 50250, netLiq: 50310, openPnL: 60, totalPnL: 310 }),
    }));

    const accounts = await tradovateAdapter.listAccounts();
    expect(accounts).toHaveLength(1);
    const a = accounts[0];
    expect(a.id).toBe('42');
    expect(a.login).toBe('DEMO42');
    expect(a.email).toBe('t@x.com');
    expect(a.assetClass).toBe('futures');
    expect(a.balance).toBe(50250);
    expect(a.equity).toBe(50310);
    expect(a.startingBalance).toBe(50000);
    expect(a.canTrade).toBe(true);
    expect(a.status).toBe('active');
  });

  it('suspend enforcement calls setadminautoliqaction with LockTradingImmediately', async () => {
    let captured: any = null;
    vi.stubGlobal('fetch', mockFetch({
      '/v1/auth/accesstokenrequest': () => ({ accessToken: 'tok', expirationTime: new Date(Date.now() + 3600_000).toISOString() }),
      '/v1/accountRiskStatus/setadminautoliqaction': (_u, init) => {
        captured = JSON.parse(String(init?.body));
        return { errorText: '' };
      },
    }));

    const res = await tradovateAdapter.enforce!('42', 'suspend');
    expect(res.ok).toBe(true);
    expect(captured.accountId).toBe(42);
    expect(captured.adminAction).toBe('LockTradingImmediately');
  });

  it('flatten enforcement liquidates each open position', async () => {
    const liquidated: number[] = [];
    vi.stubGlobal('fetch', mockFetch({
      '/v1/auth/accesstokenrequest': () => ({ accessToken: 'tok', expirationTime: new Date(Date.now() + 3600_000).toISOString() }),
      '/v1/position/list': () => [
        { id: 1, accountId: 42, contractId: 111, netPos: 2 },
        { id: 2, accountId: 42, contractId: 222, netPos: -1 },
        { id: 3, accountId: 99, contractId: 333, netPos: 5 },
      ],
      '/v1/order/liquidateposition': (_u, init) => {
        liquidated.push(JSON.parse(String(init?.body)).contractId);
        return { orderId: 1 };
      },
    }));

    const res = await tradovateAdapter.enforce!('42', 'flatten');
    expect(res.ok).toBe(true);
    expect(liquidated).toEqual([111, 222]); // only account 42's positions
  });
});

describe('tradovate per-tenant token cache', () => {
  const TENANT_A = 'tenant-a';
  const TENANT_B = 'tenant-b';

  beforeEach(() => {
    __testing.tokenCache.clear();
  });

  it('never returns tenant A\'s cached token for tenant B (or vice versa)', async () => {
    const authCalls: string[] = [];
    const authorizationHeadersSeen: string[] = [];

    vi.stubGlobal('fetch', mockFetch({
      '/v1/auth/accesstokenrequest': (_u, init) => {
        const body = JSON.parse(String(init?.body));
        authCalls.push(body.name);
        return {
          accessToken: `token-for-${body.name}`,
          expirationTime: new Date(Date.now() + 3600_000).toISOString(),
        };
      },
      '/v1/account/list': (_u, init) => {
        authorizationHeadersSeen.push(String((init?.headers as Record<string, string>)?.Authorization));
        return [];
      },
      '/v1/user/list': () => [],
    }));

    await tradovateAdapter.listAccounts(TENANT_A);
    await tradovateAdapter.listAccounts(TENANT_B);

    // Each tenant authenticated with its own credentials only — never with
    // the other tenant's (listAccounts fires /account/list and /user/list
    // concurrently, so more than one auth call per tenant is expected before
    // that tenant's cache entry is populated; what matters is no cross-tenant
    // name ever appears).
    expect(new Set(authCalls)).toEqual(new Set([`user-${TENANT_A}`, `user-${TENANT_B}`]));
    expect(authorizationHeadersSeen).toEqual([
      `Bearer token-for-user-${TENANT_A}`,
      `Bearer token-for-user-${TENANT_B}`,
    ]);

    // The cache holds two distinct entries, one per tenant, with different tokens.
    expect(__testing.tokenCache.size).toBe(2);
    expect(__testing.tokenCache.get(TENANT_A)?.token).toBe(`token-for-user-${TENANT_A}`);
    expect(__testing.tokenCache.get(TENANT_B)?.token).toBe(`token-for-user-${TENANT_B}`);
    expect(__testing.tokenCache.get(TENANT_A)?.token).not.toBe(__testing.tokenCache.get(TENANT_B)?.token);

    // Calling tenant A again reuses A's cached token (both entries now
    // populated, so no further auth calls at all) and never leaks B's token
    // into A's request.
    const authCallCountBefore = authCalls.length;
    authorizationHeadersSeen.length = 0;
    await tradovateAdapter.listAccounts(TENANT_A);
    expect(authCalls).toHaveLength(authCallCountBefore); // no new auth call
    expect(authorizationHeadersSeen).toEqual([`Bearer token-for-user-${TENANT_A}`]);
  });

  it('keys the legacy no-tenant call path separately from any real tenant', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/v1/auth/accesstokenrequest': (_u, init) => {
        const body = JSON.parse(String(init?.body));
        return {
          accessToken: `token-for-${body.name}`,
          expirationTime: new Date(Date.now() + 3600_000).toISOString(),
        };
      },
      '/v1/account/list': () => [],
      '/v1/user/list': () => [],
    }));

    await tradovateAdapter.listAccounts(); // no tenantId — legacy env path (PROVIDER_TRADOVATE_NAME=u)
    await tradovateAdapter.listAccounts(TENANT_A);

    expect(__testing.tokenCache.get('__env__')?.token).toBe('token-for-u');
    expect(__testing.tokenCache.get(TENANT_A)?.token).toBe(`token-for-user-${TENANT_A}`);
    expect(__testing.tokenCache.get('__env__')?.token).not.toBe(__testing.tokenCache.get(TENANT_A)?.token);
  });
});
