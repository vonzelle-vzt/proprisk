import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The load-bearing guarantee of the whole trader-access feature: a link
 * grants read access to EXACTLY ONE account, and possessing one tenant's link
 * can never reach another tenant's data. This is tested against a scripted
 * in-memory store (same approach as src/lib/rulepack/store.test.ts) rather
 * than a live database — what matters here is the WORKFLOW: that
 * `verifyTraderToken` always resolves a raw token to the single (tenant,
 * account) pair it was minted for, and that `tenantDb`'s tenant filter (which
 * `loadTraderView` relies on) refuses to return a row from any other tenant
 * even when handed that row's real id.
 *
 * The mock's `tenantDb.from()` filters by `tenant_id` up front, exactly like
 * the real implementation in src/lib/db/tenant-scoped.ts — that filter, plus
 * RLS at the database layer (00021_trader_access.sql, copied verbatim from
 * 00015_tenancy.sql's policy shape), is what this test is standing in for.
 */

type Row = Record<string, unknown>;

const state = {
  tokens: [] as Row[],
  accounts: [] as Row[],
  trades: [] as Row[],
  rulePacks: [] as Row[],
};

function tableRows(table: string): Row[] {
  switch (table) {
    case 'trader_access_tokens':
      return state.tokens;
    case 'accounts':
      return state.accounts;
    case 'trades':
      return state.trades;
    case 'rule_packs':
      return state.rulePacks;
    default:
      return [];
  }
}

function makeChain(initialRows: Row[]) {
  let filtered = initialRows;
  const chain = {
    select() {
      return chain;
    },
    eq(col: string, val: unknown) {
      filtered = filtered.filter((r) => r[col] === val);
      return chain;
    },
    order() {
      return chain;
    },
    maybeSingle() {
      return Promise.resolve({ data: filtered[0] ?? null, error: null });
    },
    single() {
      return Promise.resolve({
        data: filtered[0] ?? null,
        error: filtered[0] ? null : { message: 'not found' },
      });
    },
    update(patch: Row) {
      return {
        eq(col: string, val: unknown) {
          filtered.filter((r) => r[col] === val).forEach((r) => Object.assign(r, patch));
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
    },
  };
  return chain;
}

/** Mirrors src/lib/db/tenant-scoped.ts: cannot build a query without a tenant, reads pre-filtered. */
function tenantDbMock(tenantId: string) {
  return {
    tenantId,
    from(table: string) {
      return makeChain(tableRows(table).filter((r) => r.tenant_id === tenantId));
    },
    select(table: string) {
      return makeChain(tableRows(table).filter((r) => r.tenant_id === tenantId));
    },
    insert(table: string, row: Row) {
      const stamped = { id: `${table}-${tableRows(table).length + 1}`, ...row, tenant_id: tenantId };
      tableRows(table).push(stamped);
      return { select: () => ({ single: () => Promise.resolve({ data: stamped, error: null }) }) };
    },
    update(table: string, patch: Row) {
      return {
        eq(col: string, val: unknown) {
          const targets = tableRows(table).filter(
            (r) => r.tenant_id === tenantId && r[col] === val
          );
          targets.forEach((r) => Object.assign(r, patch));
          return Promise.resolve({ data: null, error: targets.length ? null : { message: 'not found' } });
        },
      };
    },
  };
}

/** The admin client bypasses tenant filtering entirely — like the real service role. */
function adminClientMock() {
  return {
    from(table: string) {
      return makeChain(tableRows(table));
    },
  };
}

vi.mock('@/lib/db/tenant-scoped', () => ({
  tenantDb: (tenantId: string) => tenantDbMock(tenantId),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => adminClientMock(),
}));

import { issueTraderLink, revokeTraderLink, verifyTraderToken } from './tokens';
import { loadTraderView } from './data';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

function activePackRow(tenantId: string) {
  return {
    id: `pack-${tenantId}`,
    tenant_id: tenantId,
    asset_class: 'forex',
    status: 'active',
    version: 1,
    pack_json: {
      schema_version: 1,
      asset_class: 'forex',
      name: 'House Rules',
      session: { timezone: 'UTC', day_start: '00:00', week_start: 'sunday' },
      rules: {},
    },
    content_hash: 'hash',
    derived_from: null,
    approved_by: null,
    approved_at: null,
    created_at: '2026-01-01T00:00:00Z',
  };
}

beforeEach(() => {
  state.tokens = [];
  state.trades = [];
  state.rulePacks = [activePackRow(TENANT_A), activePackRow(TENANT_B)];
  state.accounts = [
    {
      id: 'acct-a1',
      tenant_id: TENANT_A,
      login: 'A1',
      phase: 'funded',
      account_size: 100000,
      balance: 101000,
      equity: 101000,
    },
    {
      id: 'acct-a2',
      tenant_id: TENANT_A,
      login: 'A2',
      phase: 'funded',
      account_size: 50000,
      balance: 49000,
      equity: 49000,
    },
    {
      id: 'acct-b1',
      tenant_id: TENANT_B,
      login: 'B1',
      phase: 'funded',
      account_size: 100000,
      balance: 100000,
      equity: 100000,
    },
  ];
});

describe('a token for one account cannot read another', () => {
  it('resolves to exactly the account it was minted for, never the other', async () => {
    const linkA1 = await issueTraderLink({ tenantId: TENANT_A, accountId: 'acct-a1', createdBy: 'rm-1' });
    const linkA2 = await issueTraderLink({ tenantId: TENANT_A, accountId: 'acct-a2', createdBy: 'rm-1' });

    const verifiedA1 = await verifyTraderToken(linkA1.token);
    const verifiedA2 = await verifyTraderToken(linkA2.token);

    expect(verifiedA1?.accountId).toBe('acct-a1');
    expect(verifiedA2?.accountId).toBe('acct-a2');
    // The two links must not have been swapped or merged by the hash lookup.
    expect(verifiedA1?.accountId).not.toBe(verifiedA2?.accountId);

    const viewA1 = await loadTraderView(verifiedA1!.tenantId, verifiedA1!.accountId);
    const viewA2 = await loadTraderView(verifiedA2!.tenantId, verifiedA2!.accountId);

    expect(viewA1?.account.login).toBe('A1');
    expect(viewA2?.account.login).toBe('A2');
  });

  it('verifyTraderToken has no parameter through which a caller could name a different account', async () => {
    // The function signature itself is the guarantee: it takes only the raw
    // token. There is no accountId argument anywhere in this module for an
    // attacker (or a bug) to widen.
    expect(verifyTraderToken.length).toBe(1);
  });
});

describe('a token from one tenant cannot reach another tenant', () => {
  it('verifyTraderToken returns the issuing tenant, not any other', async () => {
    const linkB1 = await issueTraderLink({ tenantId: TENANT_B, accountId: 'acct-b1', createdBy: 'rm-2' });
    const verified = await verifyTraderToken(linkB1.token);

    expect(verified?.tenantId).toBe(TENANT_B);
    expect(verified?.accountId).toBe('acct-b1');
  });

  it('tenantDb refuses to return a row from another tenant even given its real id', async () => {
    // Simulates the failure mode ISOLATION.md exists to prevent: some future
    // bug passes the wrong tenantId alongside a real accountId. tenantDb's
    // tenant filter (mirrored here, enforced for real by RLS in
    // 00021_trader_access.sql / 00015_tenancy.sql) must still return nothing.
    const crossedIntoB = await loadTraderView(TENANT_A, 'acct-b1');
    const crossedIntoA = await loadTraderView(TENANT_B, 'acct-a1');

    expect(crossedIntoB).toBeNull();
    expect(crossedIntoA).toBeNull();
  });

  it('same-tenant access still works after proving cross-tenant access fails', async () => {
    const view = await loadTraderView(TENANT_B, 'acct-b1');
    expect(view?.account.login).toBe('B1');
  });
});

describe('token lifecycle', () => {
  it('rejects a token that does not exist', async () => {
    expect(await verifyTraderToken('0'.repeat(64))).toBeNull();
  });

  it('rejects a revoked token', async () => {
    const link = await issueTraderLink({ tenantId: TENANT_A, accountId: 'acct-a1', createdBy: 'rm-1' });
    await revokeTraderLink(TENANT_A, link.id);
    expect(await verifyTraderToken(link.token)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const link = await issueTraderLink({
      tenantId: TENANT_A,
      accountId: 'acct-a1',
      createdBy: 'rm-1',
      ttlDays: -1,
    });
    expect(await verifyTraderToken(link.token)).toBeNull();
  });

  it('a revoked link cannot be revived by issuing a new one for the same account', async () => {
    const link = await issueTraderLink({ tenantId: TENANT_A, accountId: 'acct-a1', createdBy: 'rm-1' });
    await revokeTraderLink(TENANT_A, link.id);

    const fresh = await issueTraderLink({ tenantId: TENANT_A, accountId: 'acct-a1', createdBy: 'rm-1' });
    expect(await verifyTraderToken(link.token)).toBeNull();
    expect((await verifyTraderToken(fresh.token))?.accountId).toBe('acct-a1');
  });
});
