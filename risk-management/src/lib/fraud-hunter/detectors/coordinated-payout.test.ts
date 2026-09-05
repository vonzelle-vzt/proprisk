import { beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';

const tenantDbCalls: Array<{ tenantId: string; context?: string }> = [];

/**
 * Chainable query stub mirroring the shape `tenantDb(tenantId).select(table,
 * columns)` returns (a thenable that also exposes `.eq`/`.order`/`.limit`,
 * same as the real supabase-js PostgrestBuilder). Every chained call is a
 * no-op — the fixture data is already what the detector "sees" after
 * tenant-scoping, matching the convention used elsewhere in this repo (e.g.
 * src/lib/support/tickets.test.ts) of mocking `tenantDb` itself rather than
 * the raw admin client underneath it.
 */
function queryStub(data: unknown[] | null, error: { message: string } | null) {
  const builder: any = {
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    then: (resolve: (v: { data: unknown[] | null; error: unknown }) => void) =>
      resolve({ data: error ? null : data, error }),
  };
  return builder;
}

let fixture: { table: string; data: unknown[] | null; error: { message: string } | null };

vi.mock('@/lib/db/tenant-scoped', () => ({
  tenantDb: (tenantId: string, context?: string) => {
    tenantDbCalls.push({ tenantId, context });
    return {
      select: (table: string) => {
        if (table !== fixture.table) throw new Error(`Unexpected table ${table}`);
        return queryStub(fixture.data, fixture.error);
      },
    };
  },
}));

vi.mock('@/lib/logging/logger', () => ({
  logError: vi.fn(),
}));

import { detectCoordinatedPayouts } from './coordinated-payout';

function setPayouts(payouts: unknown[], error: { message: string } | null = null) {
  fixture = { table: 'payout_history', data: payouts, error };
}

function payout(overrides: Record<string, unknown> = {}) {
  return {
    platform_payout_id: 'p-1',
    platform_account_id: 'acc-1',
    login: '1001',
    email: 'trader1@ringmail.io',
    first_name: 'Alex',
    last_name: 'Rivera',
    country: 'US',
    amount: 5000,
    client_amount: 5000,
    date_requested: new Date().toISOString(),
    decided_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('detectCoordinatedPayouts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantDbCalls.length = 0;
  });

  it('flags a cluster of 3 payouts requested within the coordination window', async () => {
    const base = new Date('2026-06-01T12:00:00Z').getTime();
    setPayouts([
      payout({ platform_payout_id: 'p1', platform_account_id: 'a1', date_requested: new Date(base).toISOString(), amount: 4000, email: 'a1@ringmail.io', country: 'US' }),
      payout({ platform_payout_id: 'p2', platform_account_id: 'a2', date_requested: new Date(base + 5 * 60 * 1000).toISOString(), amount: 4000, email: 'a2@ringmail.io', country: 'US' }),
      payout({ platform_payout_id: 'p3', platform_account_id: 'a3', date_requested: new Date(base + 10 * 60 * 1000).toISOString(), amount: 4000, email: 'a3@ringmail.io', country: 'US' }),
    ]);

    const result = await detectCoordinatedPayouts(TENANT_A);
    expect(result.fraud_type).toBe('coordinated_payout');
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding.account_ids.sort()).toEqual(['a1', 'a2', 'a3']);
    expect(finding.total_amount_at_risk).toBe(12000);
    // identity overlap: shared country (US) + shared email domain (ringmail.io) +
    // duplicated name (all fixtures default to "Alex Rivera") = 3 signals
    expect(finding.summary).toContain('Identity overlap detected (3 signals)');
    // clusterSize(3) < 4 and < 5, but clusterSize>=3 with identityOverlap>0 => high
    expect(finding.severity).toBe('high');
  });

  it('scopes the query to the given tenant', async () => {
    const base = new Date('2026-06-01T12:00:00Z').getTime();
    setPayouts([
      payout({ platform_payout_id: 'p1', platform_account_id: 'a1', date_requested: new Date(base).toISOString() }),
      payout({ platform_payout_id: 'p2', platform_account_id: 'a2', date_requested: new Date(base + 5 * 60 * 1000).toISOString() }),
      payout({ platform_payout_id: 'p3', platform_account_id: 'a3', date_requested: new Date(base + 10 * 60 * 1000).toISOString() }),
    ]);
    await detectCoordinatedPayouts(TENANT_A);
    expect(tenantDbCalls).toHaveLength(1);
    expect(tenantDbCalls[0].tenantId).toBe(TENANT_A);
  });

  it('does not flag a cluster below the configured minimum size', async () => {
    const base = new Date('2026-06-01T12:00:00Z').getTime();
    setPayouts([
      payout({ platform_payout_id: 'p1', platform_account_id: 'a1', date_requested: new Date(base).toISOString() }),
      payout({ platform_payout_id: 'p2', platform_account_id: 'a2', date_requested: new Date(base + 5 * 60 * 1000).toISOString() }),
    ]);

    const result = await detectCoordinatedPayouts(TENANT_A);
    expect(result.findings).toEqual([]);
  });

  it('does not flag a cluster below the minimum total amount threshold', async () => {
    const base = new Date('2026-06-01T12:00:00Z').getTime();
    setPayouts([
      payout({ platform_payout_id: 'p1', platform_account_id: 'a1', date_requested: new Date(base).toISOString(), amount: 100, client_amount: 100 }),
      payout({ platform_payout_id: 'p2', platform_account_id: 'a2', date_requested: new Date(base + 5 * 60 * 1000).toISOString(), amount: 100, client_amount: 100 }),
      payout({ platform_payout_id: 'p3', platform_account_id: 'a3', date_requested: new Date(base + 10 * 60 * 1000).toISOString(), amount: 100, client_amount: 100 }),
    ]);

    const result = await detectCoordinatedPayouts(TENANT_A);
    // total = 300, below min_total_amount (1000)
    expect(result.findings).toEqual([]);
  });

  it('does not flag payouts spread outside the coordination time window', async () => {
    const base = new Date('2026-06-01T12:00:00Z').getTime();
    setPayouts([
      payout({ platform_payout_id: 'p1', platform_account_id: 'a1', date_requested: new Date(base).toISOString(), amount: 4000 }),
      payout({ platform_payout_id: 'p2', platform_account_id: 'a2', date_requested: new Date(base + 2 * 60 * 60 * 1000).toISOString(), amount: 4000 }),
      payout({ platform_payout_id: 'p3', platform_account_id: 'a3', date_requested: new Date(base + 4 * 60 * 60 * 1000).toISOString(), amount: 4000 }),
    ]);

    const result = await detectCoordinatedPayouts(TENANT_A);
    // window is 60 minutes; these are hours apart
    expect(result.findings).toEqual([]);
  });

  it('reports no identity overlap when accounts have unrelated emails/countries/names', async () => {
    const base = new Date('2026-06-01T12:00:00Z').getTime();
    setPayouts([
      payout({ platform_payout_id: 'p1', platform_account_id: 'a1', date_requested: new Date(base).toISOString(), amount: 4000, email: 'one@aol.com', country: 'US', first_name: 'Amy', last_name: 'Zhao' }),
      payout({ platform_payout_id: 'p2', platform_account_id: 'a2', date_requested: new Date(base + 5 * 60 * 1000).toISOString(), amount: 4000, email: 'two@fastmail.com', country: 'CA', first_name: 'Ben', last_name: 'Cole' }),
      payout({ platform_payout_id: 'p3', platform_account_id: 'a3', date_requested: new Date(base + 10 * 60 * 1000).toISOString(), amount: 4000, email: 'three@protonmail.net', country: 'DE', first_name: 'Cara', last_name: 'Diaz' }),
    ]);

    const result = await detectCoordinatedPayouts(TENANT_A);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].summary).toContain('No identity overlap detected');
  });

  it('returns no findings and does not throw on a Supabase query error', async () => {
    setPayouts([], { message: 'db down' });
    const result = await detectCoordinatedPayouts(TENANT_A);
    expect(result.findings).toEqual([]);
    expect(result.fraud_type).toBe('coordinated_payout');
  });
});
