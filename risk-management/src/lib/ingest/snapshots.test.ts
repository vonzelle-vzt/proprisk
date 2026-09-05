import { beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

/**
 * In-memory `equity_snapshots` / `accounts` tables, filtered/mutated the way
 * the real supabase-js query builder would be. Modelled on
 * src/lib/connections/store.test.ts's harness, extended with the comparison
 * operators (gte/lte/lt/in) this module's queries actually use.
 */
let rows: Record<string, unknown>[] = [];

function applyFilters(matched: Record<string, unknown>[], filters: Array<[string, string, unknown]>) {
  for (const [op, col, val] of filters) {
    switch (op) {
      case 'eq':
        matched = matched.filter((r) => r[col] === val);
        break;
      case 'gte':
        matched = matched.filter((r) => String(r[col]) >= String(val));
        break;
      case 'lte':
        matched = matched.filter((r) => String(r[col]) <= String(val));
        break;
      case 'lt':
        matched = matched.filter((r) => String(r[col]) < String(val));
        break;
      case 'in':
        matched = matched.filter((r) => (val as unknown[]).includes(r[col]));
        break;
    }
  }
  return matched;
}

function makeBuilder(
  table: string,
  opts: { mutate?: (matched: Record<string, unknown>[]) => void; onDelete?: boolean } = {}
) {
  const filters: Array<[string, string, unknown]> = [];
  let sortCol: string | null = null;
  let sortAsc = true;

  const resolve = () => {
    let matched = rows.filter((r) => r._table === table);
    matched = applyFilters(matched, filters);
    if (sortCol) {
      matched = [...matched].sort((a, b) => {
        const av = String(a[sortCol as string]);
        const bv = String(b[sortCol as string]);
        return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (opts.onDelete) {
      const keep = new Set(matched);
      rows = rows.filter((r) => !keep.has(r));
    } else if (opts.mutate) {
      opts.mutate(matched);
    }
    return matched;
  };

  const builder: any = {
    eq(col: string, val: unknown) {
      filters.push(['eq', col, val]);
      return builder;
    },
    gte(col: string, val: unknown) {
      filters.push(['gte', col, val]);
      return builder;
    },
    lte(col: string, val: unknown) {
      filters.push(['lte', col, val]);
      return builder;
    },
    lt(col: string, val: unknown) {
      filters.push(['lt', col, val]);
      return builder;
    },
    in(col: string, val: unknown[]) {
      filters.push(['in', col, val]);
      return builder;
    },
    order(col: string, options?: { ascending?: boolean }) {
      sortCol = col;
      sortAsc = options?.ascending ?? true;
      return builder;
    },
    select() {
      return builder;
    },
    returns() {
      return builder;
    },
    then(onResolve: (v: { data: unknown; error: null }) => void) {
      const matched = resolve();
      return onResolve({ data: matched, error: null });
    },
  };
  return builder;
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => makeBuilder(table),
      insert: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
        const arr = Array.isArray(payload) ? payload : [payload];
        const inserted = arr.map((p) => ({ ...p, _table: table, id: p.id || `id-${rows.length}-${Math.random()}` }));
        rows.push(...inserted);
        return makeBuilder(table);
      },
      upsert: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
        const arr = Array.isArray(payload) ? payload : [payload];
        for (const p of arr) {
          const idx = rows.findIndex(
            (r) =>
              r._table === table &&
              r.tenant_id === p.tenant_id &&
              r.account_id === p.account_id &&
              r.captured_at === p.captured_at
          );
          if (idx >= 0) rows[idx] = { ...rows[idx], ...p, _table: table };
          else rows.push({ ...p, _table: table, id: `id-${rows.length}-${Math.random()}` });
        }
        return makeBuilder(table);
      },
      delete: () => makeBuilder(table, { onDelete: true }),
    }),
  }),
}));

beforeEach(() => {
  rows = [];
});

import {
  getSnapshotFidelity,
  loadEquitySnapshots,
  pruneSnapshots,
  recordSnapshots,
  resolveAccountIdsByLogin,
} from './snapshots';

describe('recordSnapshots + loadEquitySnapshots', () => {
  it('writes snapshots and loads them back in EquitySnapshot shape, ascending', async () => {
    await recordSnapshots(TENANT_A, [
      { accountId: 'acct-1', capturedAt: '2026-08-01T10:00:00Z', balance: 100000, equity: 101000, source: 'poll' },
      { accountId: 'acct-1', capturedAt: '2026-08-01T09:00:00Z', balance: 100000, equity: 99500, source: 'poll' },
    ]);

    const snaps = await loadEquitySnapshots(TENANT_A, 'acct-1', { from: '2026-08-01T00:00:00Z' });
    expect(snaps).toEqual([
      { at: '2026-08-01T09:00:00Z', balance: 100000, equity: 99500 },
      { at: '2026-08-01T10:00:00Z', balance: 100000, equity: 101000 },
    ]);
  });

  it('a retried write at the same (account_id, captured_at) is idempotent, not a duplicate', async () => {
    const row = { accountId: 'acct-1', capturedAt: '2026-08-01T10:00:00Z', balance: 100000, equity: 101000, source: 'poll' as const };
    await recordSnapshots(TENANT_A, [row]);
    await recordSnapshots(TENANT_A, [row]); // retry

    const snaps = await loadEquitySnapshots(TENANT_A, 'acct-1', { from: '2026-08-01T00:00:00Z' });
    expect(snaps).toHaveLength(1);
  });

  it('tenant B cannot see tenant A snapshots for the same account id', async () => {
    await recordSnapshots(TENANT_A, [
      { accountId: 'acct-1', capturedAt: '2026-08-01T10:00:00Z', balance: 100000, equity: 101000, source: 'poll' },
    ]);

    const snaps = await loadEquitySnapshots(TENANT_B, 'acct-1', { from: '2026-08-01T00:00:00Z' });
    expect(snaps).toEqual([]);
  });

  it('respects the window bounds', async () => {
    await recordSnapshots(TENANT_A, [
      { accountId: 'acct-1', capturedAt: '2026-08-01T09:00:00Z', balance: 100000, equity: 99500, source: 'poll' },
      { accountId: 'acct-1', capturedAt: '2026-08-03T09:00:00Z', balance: 100000, equity: 98000, source: 'poll' },
    ]);

    const snaps = await loadEquitySnapshots(TENANT_A, 'acct-1', {
      from: '2026-08-01T00:00:00Z',
      to: '2026-08-01T23:59:59Z',
    });
    expect(snaps).toHaveLength(1);
    expect(snaps[0].equity).toBe(99500);
  });
});

describe('getSnapshotFidelity', () => {
  it('reports the configured interval and the largest observed gap', async () => {
    await recordSnapshots(TENANT_A, [
      { accountId: 'acct-1', capturedAt: '2026-08-01T09:00:00Z', balance: 100000, equity: 100000, source: 'poll', sampleIntervalSeconds: 300 },
      { accountId: 'acct-1', capturedAt: '2026-08-01T09:05:00Z', balance: 100000, equity: 100500, source: 'poll', sampleIntervalSeconds: 300 },
      { accountId: 'acct-1', capturedAt: '2026-08-01T09:20:00Z', balance: 100000, equity: 99000, source: 'poll', sampleIntervalSeconds: 300 },
    ]);

    const fidelity = await getSnapshotFidelity(TENANT_A, 'acct-1', { from: '2026-08-01T00:00:00Z' });
    expect(fidelity.intervalKnown).toBe(true);
    expect(fidelity.maxIntervalSeconds).toBe(300);
    expect(fidelity.maxObservedGapSeconds).toBe(15 * 60);
    expect(fidelity.sampleCount).toBe(3);
  });

  it('reports unknown fidelity when any row has no interval — never claims certainty it cannot back up', async () => {
    await recordSnapshots(TENANT_A, [
      { accountId: 'acct-1', capturedAt: '2026-08-01T09:00:00Z', balance: 100000, equity: 100000, source: 'push' },
    ]);

    const fidelity = await getSnapshotFidelity(TENANT_A, 'acct-1', { from: '2026-08-01T00:00:00Z' });
    expect(fidelity.intervalKnown).toBe(false);
    expect(fidelity.maxIntervalSeconds).toBeNull();
  });
});

describe('pruneSnapshots', () => {
  it('deletes rows older than the retention window and keeps newer ones', async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();

    await recordSnapshots(TENANT_A, [
      { accountId: 'acct-1', capturedAt: old, balance: 100000, equity: 100000, source: 'poll' },
      { accountId: 'acct-1', capturedAt: recent, balance: 100000, equity: 100000, source: 'poll' },
    ]);

    const ok = await pruneSnapshots(TENANT_A, 7);
    expect(ok).toBe(true);

    const remaining = await loadEquitySnapshots(TENANT_A, 'acct-1', { from: '2000-01-01T00:00:00Z' });
    expect(remaining).toHaveLength(1);
  });
});

describe('resolveAccountIdsByLogin', () => {
  it('resolves known logins within the tenant and reports the rest as unresolved', async () => {
    rows.push({ _table: 'accounts', tenant_id: TENANT_A, id: 'acct-1', login: '10001' });
    rows.push({ _table: 'accounts', tenant_id: TENANT_B, id: 'acct-b', login: '10002' });

    const { byLogin, unresolved } = await resolveAccountIdsByLogin(TENANT_A, ['10001', '10002', '10003']);
    expect(byLogin.get('10001')).toBe('acct-1');
    expect(byLogin.has('10002')).toBe(false); // belongs to tenant B
    expect(unresolved.sort()).toEqual(['10002', '10003']);
  });
});
