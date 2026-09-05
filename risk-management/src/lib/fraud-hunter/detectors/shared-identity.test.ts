import { beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';

const tenantDbCalls: Array<{ tenantId: string; context?: string }> = [];

/**
 * Chainable query stub mirroring the shape `tenantDb(tenantId).select(table,
 * columns)` returns (a thenable that also exposes `.eq`/`.gte`/`.order`/
 * `.limit`, same as the real supabase-js PostgrestBuilder). Every chained
 * call is a no-op here — the fixture data is already what the detector
 * "sees" after tenant-scoping, matching the convention used elsewhere in
 * this repo (e.g. src/lib/support/tickets.test.ts) of mocking `tenantDb`
 * itself rather than the raw admin client underneath it.
 */
function queryStub(data: unknown[] | null, error: { message: string } | null) {
  const builder: any = {
    eq: () => builder,
    gte: () => builder,
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

import { detectSharedIdentity } from './shared-identity';

function setSnapshots(snapshots: unknown[], error: { message: string } | null = null) {
  fixture = { table: 'account_snapshots', data: snapshots, error };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    platform_account_id: 'acc-1',
    login: '1001',
    email: 'trader1@customdomain.com',
    first_name: 'Alex',
    last_name: 'Rivera',
    country: 'US',
    plan: 'Standard',
    starting_balance: 10000,
    balance: 10500,
    total_pnl: 500,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('detectSharedIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantDbCalls.length = 0;
  });

  it('flags accounts sharing an uncommon email domain with a confidence-weighted score', async () => {
    setSnapshots([
      snapshot({ platform_account_id: 'a1', email: 'alex1@ringmail.io', country: 'US', balance: 1000 }),
      snapshot({ platform_account_id: 'a2', email: 'alex2@ringmail.io', country: 'US', balance: 2000 }),
    ]);

    const result = await detectSharedIdentity(TENANT_A);
    expect(result.fraud_type).toBe('shared_identity');
    const finding = result.findings.find((f) => f.title.includes('ringmail.io'));
    expect(finding).toBeDefined();
    // sharedDomain(30) + prefix similarity ("alex1" vs "alex2" -> no substring match: false) + sharedCountry(10) = 40
    expect(finding!.confidence_score).toBe(40);
    expect(finding!.severity).toBe('medium'); // 40 -> medium (>=40)
    expect(finding!.total_amount_at_risk).toBe(3000);
    expect(finding!.account_ids.sort()).toEqual(['a1', 'a2']);
  });

  it('scopes the query to the given tenant', async () => {
    setSnapshots([snapshot(), snapshot({ platform_account_id: 'a2' })]);
    await detectSharedIdentity(TENANT_A);
    expect(tenantDbCalls).toHaveLength(1);
    expect(tenantDbCalls[0].tenantId).toBe(TENANT_A);
  });

  it('excludes common email providers (gmail, yahoo, etc.) from domain clustering', async () => {
    setSnapshots([
      snapshot({ platform_account_id: 'a1', email: 'trader1@gmail.com', country: 'US' }),
      snapshot({ platform_account_id: 'a2', email: 'trader2@gmail.com', country: 'US' }),
    ]);

    const result = await detectSharedIdentity(TENANT_A);
    expect(result.findings.some((f) => f.title.includes('gmail.com'))).toBe(false);
  });

  it('flags exact name matches across different emails', async () => {
    setSnapshots([
      snapshot({ platform_account_id: 'a1', email: 'one@gmail.com', first_name: 'Sam', last_name: 'Lee', country: 'CA' }),
      snapshot({ platform_account_id: 'a2', email: 'two@yahoo.com', first_name: 'Sam', last_name: 'Lee', country: 'CA' }),
    ]);

    const result = await detectSharedIdentity(TENANT_A);
    const finding = result.findings.find((f) => f.title.includes('sam lee'));
    expect(finding).toBeDefined();
    // sharedName(35) + sharedCountry(10) = 45
    expect(finding!.confidence_score).toBe(45);
    expect(finding!.severity).toBe('medium');
  });

  it('boosts confidence to high/critical when domain + prefix + country all overlap', async () => {
    setSnapshots([
      snapshot({ platform_account_id: 'a1', email: 'ringtrader@shared-broker-mail.net', country: 'BR' }),
      snapshot({ platform_account_id: 'a2', email: 'ringtrader2@shared-broker-mail.net', country: 'BR' }),
    ]);

    const result = await detectSharedIdentity(TENANT_A);
    const finding = result.findings.find((f) => f.title.includes('shared-broker-mail.net'));
    expect(finding).toBeDefined();
    // domain(30) + prefix("ringtrader" is a substring of "ringtrader2")(25) + country(10) = 65
    expect(finding!.confidence_score).toBe(65);
    expect(finding!.severity).toBe('high');
  });

  it('returns no findings when fewer than 2 snapshots exist', async () => {
    setSnapshots([snapshot()]);
    const result = await detectSharedIdentity(TENANT_A);
    expect(result.findings).toEqual([]);
  });

  it('returns no findings and does not throw on a Supabase query error', async () => {
    setSnapshots([], { message: 'db down' });
    const result = await detectSharedIdentity(TENANT_A);
    expect(result.findings).toEqual([]);
    expect(result.fraud_type).toBe('shared_identity');
  });

  it('does not flag accounts that merely share a country with no other signal', async () => {
    setSnapshots([
      snapshot({ platform_account_id: 'a1', email: 'unrelated1@gmail.com', first_name: 'Amy', last_name: 'Zhao', country: 'US' }),
      snapshot({ platform_account_id: 'a2', email: 'unrelated2@yahoo.com', first_name: 'Ben', last_name: 'Cole', country: 'US' }),
    ]);
    const result = await detectSharedIdentity(TENANT_A);
    expect(result.findings).toEqual([]);
  });
});
