import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE load-bearing test for this pass.
 *
 * Before the fix: all five detectors called `createAdminClient()` (service
 * role, bypasses RLS) with no tenant filter and correlated every account in
 * the database against every other account — so a "copy-trading ring" or
 * "coordinated payout ring" finding could name accounts from two unrelated
 * prop firms. This seeds TWO tenants with data that looks correlated by
 * every detector's heuristic (shared email domain, same country/plan,
 * near-identical balances and trade timing, payouts in the same window,
 * even a byte-identical email string used by both tenants) and asserts a
 * scan for one tenant never produces a finding naming the other tenant's
 * accounts.
 *
 * `tenantDb` is mocked with an in-memory store that filters every read by
 * `tenant_id` — the same guarantee the real `tenantDb()` gives via
 * `.eq('tenant_id', id)` (src/lib/db/tenant-scoped.ts) — so this test proves
 * the detectors actually thread `tenantId` into their queries rather than
 * asserting the mock's own behavior.
 */

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

type Row = Record<string, any>;

let db: Record<string, Row[]>;
const tenantDbCalls: Array<{ tenantId: string; context?: string }> = [];

function filterByTenant(rows: Row[], tenantId: string): Row[] {
  return rows.filter((r) => r.tenant_id === tenantId).map((r) => ({ ...r }));
}

function makeQuery(rows: Row[]) {
  let data = rows;
  const builder: any = {
    eq: (col: string, val: string | number | boolean) => {
      data = data.filter((r) => r[col] === val);
      return builder;
    },
    gte: (col: string, val: string | number) => {
      data = data.filter((r) => r[col] >= val);
      return builder;
    },
    order: () => builder,
    limit: (n: number) => {
      data = data.slice(0, n);
      return builder;
    },
    returns: () => builder,
    maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
    then: (resolve: (v: { data: Row[]; error: null }) => void) => resolve({ data, error: null }),
  };
  return builder;
}

vi.mock('@/lib/db/tenant-scoped', () => ({
  tenantDb: (tenantId: string, context?: string) => {
    tenantDbCalls.push({ tenantId, context });
    return {
      select: (table: string) => makeQuery(filterByTenant(db[table] || [], tenantId)),
      from: (table: string) => makeQuery(filterByTenant(db[table] || [], tenantId)),
      upsert: (table: string, row: Row, options?: { onConflict?: string }) => {
        expect(options?.onConflict).toBe('tenant_id,dedupe_key');
        const stamped = { ...row, tenant_id: tenantId };
        db[table] = db[table] || [];
        db[table].push(stamped);
        return {
          select: () => ({
            maybeSingle: async () => ({ data: stamped, error: null }),
          }),
        };
      },
    };
  },
}));

vi.mock('@/lib/logging/logger', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock('@/lib/deductions/audit', () => ({
  logAuditEvent: vi.fn(async () => null),
}));

import { runFraudHunterScan } from './agent';

/** Two accounts per tenant, correlated by every copy-ring/shared-identity
 *  signal (same country, plan, balances, traded days, uncommon email domain)
 *  — mirrored byte-for-byte between tenants except for id/tenant. */
function copyRingPair(tenantId: string, prefix: string) {
  return [
    {
      tenant_id: tenantId,
      platform_account_id: `${prefix}1`,
      login: `${prefix}1`,
      email: `alex1@ringmail.io`,
      first_name: 'Alex',
      last_name: 'One',
      country: 'US',
      plan: 'Standard',
      starting_balance: 10000,
      balance: 10500,
      total_pnl: 500,
      traded_days: 10,
      num_approved_payouts: 1,
      is_blacklisted: false,
      deductions_total: 0,
      deductions_by_type: { overleveraging: 1, hft: 1 },
      violation_count: 1,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    },
    {
      tenant_id: tenantId,
      platform_account_id: `${prefix}2`,
      login: `${prefix}2`,
      email: `alex2@ringmail.io`,
      first_name: 'Alex',
      last_name: 'Two',
      country: 'US',
      plan: 'Standard',
      starting_balance: 10000,
      balance: 10400,
      total_pnl: 400,
      traded_days: 11,
      num_approved_payouts: 1,
      is_blacklisted: false,
      deductions_total: 0,
      deductions_by_type: { overleveraging: 1, hft: 1 },
      violation_count: 1,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    },
  ];
}

/** Same-user (byte-identical email, even across tenants) profit-manipulation
 *  pair: one profitable, one at an offsetting loss with matching deductions. */
function profitManipulationPair(tenantId: string, prefix: string) {
  return [
    {
      tenant_id: tenantId,
      platform_account_id: `${prefix}-winner`,
      login: `${prefix}-winner`,
      email: 'duo@ringmail.io',
      first_name: 'Dana',
      last_name: 'Duo',
      country: 'CA',
      plan: 'Elite',
      starting_balance: 10000,
      balance: 13000,
      total_pnl: 3000,
      deductions_total: 0,
      deductions_by_type: {},
      num_approved_payouts: 2,
      updated_at: new Date().toISOString(),
    },
    {
      tenant_id: tenantId,
      platform_account_id: `${prefix}-loser`,
      login: `${prefix}-loser`,
      email: 'duo@ringmail.io',
      first_name: 'Dana',
      last_name: 'Duo',
      country: 'CA',
      plan: 'Elite',
      starting_balance: 10000,
      balance: 7000,
      total_pnl: -3000,
      deductions_total: 1000,
      deductions_by_type: { overleveraging: 1 },
      num_approved_payouts: 0,
      updated_at: new Date().toISOString(),
    },
  ];
}

/** Three payouts in the same tight window, same country/domain — coordinated-
 *  payout bait, mirrored at the exact same timestamps for both tenants. */
function coordinatedPayouts(tenantId: string, prefix: string, base: number) {
  return [0, 5, 10].map((minOffset, i) => ({
    tenant_id: tenantId,
    platform_payout_id: `${prefix}-p${i + 1}`,
    platform_account_id: `${prefix}${i + 1}`,
    login: `${prefix}${i + 1}`,
    email: `${prefix}${i + 1}@ringmail.io`,
    first_name: 'Alex',
    last_name: 'Rivera',
    country: 'US',
    amount: 4000,
    client_amount: 4000,
    decision: 'pending',
    date_requested: new Date(base + minOffset * 60 * 1000).toISOString(),
    decided_at: null,
    created_at: new Date(base + minOffset * 60 * 1000).toISOString(),
  }));
}

function allAccountIdsInDb(): Set<string> {
  const ids = new Set<string>();
  for (const row of db.account_snapshots) ids.add(row.platform_account_id);
  for (const row of db.payout_history) ids.add(row.platform_account_id);
  return ids;
}

function accountIdsForTenant(tenantId: string): Set<string> {
  const ids = new Set<string>();
  for (const row of db.account_snapshots) if (row.tenant_id === tenantId) ids.add(row.platform_account_id);
  for (const row of db.payout_history) if (row.tenant_id === tenantId) ids.add(row.platform_account_id);
  return ids;
}

describe('fraud-hunter tenant isolation (the leak this pass closes)', () => {
  beforeEach(() => {
    tenantDbCalls.length = 0;

    const payoutBase = new Date('2026-06-01T12:00:00Z').getTime();

    db = {
      account_snapshots: [
        ...copyRingPair(TENANT_A, 'a'),
        ...profitManipulationPair(TENANT_A, 'a'),
        ...copyRingPair(TENANT_B, 'b'),
        ...profitManipulationPair(TENANT_B, 'b'),
      ],
      payout_history: [
        ...coordinatedPayouts(TENANT_A, 'a', payoutBase),
        ...coordinatedPayouts(TENANT_B, 'b', payoutBase),
      ],
      fraud_investigations: [],
    };
  });

  it('produces findings for tenant A that reference only tenant A accounts', async () => {
    const result = await runFraudHunterScan(TENANT_A);

    const tenantAIds = accountIdsForTenant(TENANT_A);
    const otherIds = new Set([...allAccountIdsInDb()].filter((id) => !tenantAIds.has(id)));

    expect(result.total_findings).toBeGreaterThan(0);
    for (const detectorResult of result.results) {
      for (const finding of detectorResult.findings) {
        for (const accountId of finding.account_ids) {
          expect(tenantAIds.has(accountId)).toBe(true);
          expect(otherIds.has(accountId)).toBe(false);
        }
      }
    }
  });

  it('produces findings for tenant B that reference only tenant B accounts', async () => {
    const result = await runFraudHunterScan(TENANT_B);

    const tenantBIds = accountIdsForTenant(TENANT_B);
    const otherIds = new Set([...allAccountIdsInDb()].filter((id) => !tenantBIds.has(id)));

    expect(result.total_findings).toBeGreaterThan(0);
    for (const detectorResult of result.results) {
      for (const finding of detectorResult.findings) {
        for (const accountId of finding.account_ids) {
          expect(tenantBIds.has(accountId)).toBe(true);
          expect(otherIds.has(accountId)).toBe(false);
        }
      }
    }
  });

  it("does not surface any of Firm B's accounts when scanning Firm A, even though the data is byte-identical bait", async () => {
    const result = await runFraudHunterScan(TENANT_A);
    const allAccountIds = result.results.flatMap((r) => r.findings.flatMap((f) => f.account_ids));
    expect(allAccountIds.some((id) => id.startsWith('b'))).toBe(false);
  });

  it('never groups the two tenants into a single "copy ring" despite identical emails/countries/plans', async () => {
    const resultA = await runFraudHunterScan(TENANT_A);
    const resultB = await runFraudHunterScan(TENANT_B);

    const allFindings = [...resultA.results, ...resultB.results].flatMap((r) => r.findings);
    for (const f of allFindings) {
      const prefixes = new Set(f.account_ids.map((id) => id[0]));
      // every finding's account_ids come from exactly one tenant's id prefix
      expect(prefixes.size).toBe(1);
    }
  });

  it('threads the real tenantId into every detector query — not hardcoded, not optional', async () => {
    await runFraudHunterScan(TENANT_A);
    expect(tenantDbCalls.length).toBeGreaterThan(0);
    expect(tenantDbCalls.every((c) => c.tenantId === TENANT_A)).toBe(true);
  });

  it('persists findings under the tenant they were scanned for', async () => {
    const result = await runFraudHunterScan(TENANT_A);
    expect(result.new_investigations).toBeGreaterThan(0);
    expect(result.persistence_errors).toBe(0);
    expect(db.fraud_investigations.every((row) => row.tenant_id === TENANT_A)).toBe(true);
  });
});
