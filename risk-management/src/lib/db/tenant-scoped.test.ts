import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A recording stub for the supabase-js builder. Each terminal call records what
 * it was asked to do so the tests can assert on the *shape* of the query the
 * DAL produced, not on a live database.
 */
const calls: Array<Record<string, unknown>> = [];

function builder(table: string) {
  const chain: Record<string, unknown> = {};
  const record = (op: string, payload?: unknown) => {
    calls.push({ table, op, payload });
    return chain;
  };
  chain.select = (columns?: unknown) => record('select', columns);
  chain.insert = (rows: unknown) => record('insert', rows);
  chain.update = (patch: unknown) => record('update', patch);
  chain.upsert = (rows: unknown) => record('upsert', rows);
  chain.delete = () => record('delete');
  chain.eq = (col: string, val: unknown) => record('eq', { col, val });
  return chain;
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => builder(table),
    rpc: (fn: string, args: unknown) => {
      calls.push({ table: fn, op: 'rpc', payload: args });
      return {};
    },
  }),
}));

import { MissingTenantError, globalTable, tenantDb } from './tenant-scoped';

const T = 'aaaaaaaa-0000-0000-0000-000000000001';

function opsFor(op: string) {
  return calls.filter((c) => c.op === op);
}

describe('tenantDb — a tenant is not optional', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it.each([
    ['empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['not a uuid', 'tenant-1'],
    ['sql-ish junk', "' OR 1=1 --"],
  ])('throws MissingTenantError for %s', (_label, value) => {
    expect(() => tenantDb(value as string)).toThrow(MissingTenantError);
  });

  it('names the calling context in the error, so the offending job is findable', () => {
    expect(() => tenantDb('', 'detect-violations cron')).toThrow(/detect-violations cron/);
  });
});

describe('tenantDb — reads are pre-filtered', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('filters from() by tenant_id', () => {
    tenantDb(T).from('accounts');
    expect(opsFor('eq')).toEqual([
      { table: 'accounts', op: 'eq', payload: { col: 'tenant_id', val: T } },
    ]);
  });

  it('filters select() by tenant_id', () => {
    tenantDb(T).select('trades', 'id, profit');
    expect(opsFor('select')[0].payload).toBe('id, profit');
    expect(opsFor('eq')[0].payload).toEqual({ col: 'tenant_id', val: T });
  });

  it('filters delete() by tenant_id', () => {
    tenantDb(T).delete('violations');
    expect(opsFor('eq')[0].payload).toEqual({ col: 'tenant_id', val: T });
  });
});

describe('tenantDb — writes are stamped and cannot be redirected', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('stamps a single insert', () => {
    tenantDb(T).insert('violations', { account_id: 'a1' });
    expect(opsFor('insert')[0].payload).toEqual([{ account_id: 'a1', tenant_id: T }]);
  });

  it('stamps every row of a bulk insert', () => {
    tenantDb(T).insert('trades', [{ id: 1 }, { id: 2 }]);
    expect(opsFor('insert')[0].payload).toEqual([
      { id: 1, tenant_id: T },
      { id: 2, tenant_id: T },
    ]);
  });

  // The bound tenant wins over anything in the payload. A caller-supplied
  // tenant_id — mistaken, or reflected from user input — must not be able to
  // redirect a service-role write into another firm.
  it('OVERRIDES a tenant_id supplied by the caller on insert', () => {
    const attacker = 'bbbbbbbb-0000-0000-0000-000000000002';
    tenantDb(T).insert('accounts', { login: '1001', tenant_id: attacker });
    expect(opsFor('insert')[0].payload).toEqual([{ login: '1001', tenant_id: T }]);
  });

  it('OVERRIDES a caller-supplied tenant_id on upsert', () => {
    tenantDb(T).upsert('accounts', { login: '1', tenant_id: 'bbbbbbbb-0000-0000-0000-000000000002' });
    expect(opsFor('upsert')[0].payload).toEqual([{ login: '1', tenant_id: T }]);
  });

  // UPDATE strips the column entirely rather than overwriting it: re-stamping
  // would be a no-op write, but silently permitting `SET tenant_id = ...` would
  // let a row be moved across the boundary.
  it('DISCARDS tenant_id from an update patch and scopes the update', () => {
    tenantDb(T).update('accounts', { balance: 10, tenant_id: 'bbbbbbbb-0000-0000-0000-000000000002' });
    expect(opsFor('update')[0].payload).toEqual({ balance: 10 });
    expect(opsFor('eq')[0].payload).toEqual({ col: 'tenant_id', val: T });
  });

  it('injects the tenant into rpc arguments', () => {
    tenantDb(T).rpc('execute_deduction_atomic', { p_amount: 100 });
    expect(opsFor('rpc')[0].payload).toEqual({ p_amount: 100, p_tenant_id: T });
  });
});

describe('the global/tenant boundary is explicit in both directions', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('refuses to serve a global table through the tenant handle', () => {
    expect(() => tenantDb(T).from('news_events')).toThrow(/globalTable/);
  });

  it('refuses to serve a tenant table through globalTable', () => {
    expect(() => globalTable('accounts')).toThrow(/tenant-scoped/);
  });

  it('serves genuinely global reference data', () => {
    globalTable('news_events');
    expect(calls).toEqual([]); // no implicit filter applied, and no throw
  });
});
