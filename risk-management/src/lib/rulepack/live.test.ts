import { beforeEach, describe, expect, it, vi } from 'vitest';

const tenantDbMock = vi.fn();
const globalTableMock = vi.fn();
const activePackMock = vi.fn();
const loadEquitySnapshotsMock = vi.fn();

vi.mock('@/lib/db/tenant-scoped', () => ({
  tenantDb: (...args: unknown[]) => tenantDbMock(...args),
  globalTable: (...args: unknown[]) => globalTableMock(...args),
}));

vi.mock('@/lib/ingest/snapshots', () => ({
  loadEquitySnapshots: (...args: unknown[]) => loadEquitySnapshotsMock(...args),
}));

vi.mock('./store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store')>();
  return { ...actual, activePack: (...args: unknown[]) => activePackMock(...args) };
});

import { evaluateTenantLive, persistBreachDecisions } from './live';
import { parseRulePack, type RulePack } from './schema';
import type { StoredRulePack } from './store';
import type { BreachDecision } from './types';

const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACCOUNT_A = 'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = '2026-03-10T22:00:00Z';

function pack(): RulePack {
  const { pack: parsed, validation } = parseRulePack({
    schema_version: 1,
    asset_class: 'futures',
    name: 'Live test pack',
    session: { timezone: 'America/New_York', day_start: '17:00', week_start: 'sunday' },
    rules: {
      daily_loss: {
        enabled: true,
        basis: 'balance',
        include_open_pnl: false,
        threshold: { type: 'fixed', value: 1000 },
        applies_to_phases: ['challenge', 'verification', 'funded'],
        action: 'terminate',
      },
      drawdown: {
        enabled: true,
        mode: 'trailing_intraday',
        lock: 'never',
        basis: 'equity',
        threshold: { type: 'fixed', value: 5000 },
        applies_to_phases: ['challenge', 'verification', 'funded'],
        action: 'terminate',
      },
    },
  });
  expect(validation.errors).toEqual([]);
  return parsed;
}

function storedPack(): StoredRulePack {
  return {
    id: 'pack-1',
    tenantId: TENANT,
    name: 'Live test pack',
    assetClass: 'futures',
    version: 2,
    status: 'active',
    pack: pack(),
    contentHash: 'hash-1',
    derivedFrom: null,
    approvedBy: 'risk@firm.test',
    approvedAt: NOW,
    createdAt: NOW,
  };
}

/** Chainable stand-in for the PostgREST builder, resolving to fixed rows. */
function rows(data: unknown[]) {
  const builder: Record<string, unknown> = {
    eq: () => builder,
    in: () => builder,
    gte: () => builder,
    lte: () => builder,
    order: () => builder,
    limit: () => builder,
    returns: () => builder,
    select: () => builder,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data, error: null }).then(resolve, reject),
  };
  return builder;
}

function db(tables: Record<string, unknown[]>) {
  return {
    tenantId: TENANT,
    select: (table: string) => rows(tables[table] ?? []),
    from: (table: string) => rows(tables[table] ?? []),
    insert: vi.fn(),
    update: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadEquitySnapshotsMock.mockResolvedValue([]);
  globalTableMock.mockReturnValue(rows([]));
});

describe('evaluateTenantLive', () => {
  it('reports no active pack rather than an empty breach list', async () => {
    activePackMock.mockResolvedValue(null);

    const result = await evaluateTenantLive({ tenantId: TENANT, assetClass: 'forex', now: NOW });

    expect(result).toEqual({ pack: null, packVersion: null, results: [], skippedAccounts: 0 });
    // No account book is even read: "no rulebook" is answered before any work,
    // and must never be reported as "nothing breached".
    expect(tenantDbMock).not.toHaveBeenCalled();
  });

  it('evaluates the live book and reports rules it could not evaluate', async () => {
    activePackMock.mockResolvedValue(storedPack());
    tenantDbMock.mockReturnValue(
      db({
        accounts: [
          { id: ACCOUNT_A, login: '1001', phase: 'funded', account_size: 100000, balance: 98500, equity: 98500 },
        ],
        trades: [
          {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            account_id: ACCOUNT_A,
            symbol: 'ES',
            asset_class: 'indices',
            open_time: '2026-03-02T14:00:00Z',
            close_time: '2026-03-02T15:00:00Z',
            profit: '-1500',
            lot_size: '1',
          },
        ],
      })
    );

    const result = await evaluateTenantLive({ tenantId: TENANT, assetClass: 'futures', now: NOW });

    expect(result.pack?.id).toBe('pack-1');
    expect(result.packVersion).toBe('pack-1:v2');
    expect(result.results).toHaveLength(1);

    const account = result.results[0];
    expect(account.decisions).toHaveLength(1);
    expect(account.decisions[0].ruleId).toBe('daily_loss');
    expect(account.decisions[0].action).toBe('terminate');
    expect(account.decisions[0].evidence.sessionDay).toBe('2026-03-02');

    // trailing_intraday with no snapshots is NOT "no breach".
    expect(account.skipped).toEqual([
      { ruleId: 'drawdown', reason: expect.stringContaining('intraday equity snapshots') },
    ]);
  });

  it('is deterministic: the same tape and the same `now` produce the same keys', async () => {
    activePackMock.mockResolvedValue(storedPack());
    const tables = {
      accounts: [
        { id: ACCOUNT_A, login: '1001', phase: 'funded', account_size: 100000, balance: 98500, equity: 98500 },
      ],
      trades: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          account_id: ACCOUNT_A,
          symbol: 'ES',
          asset_class: 'indices',
          open_time: '2026-03-02T14:00:00Z',
          close_time: '2026-03-02T15:00:00Z',
          profit: '-1500',
          lot_size: '1',
        },
      ],
    };
    tenantDbMock.mockReturnValue(db(tables));

    const first = await evaluateTenantLive({ tenantId: TENANT, assetClass: 'futures', now: NOW });
    const second = await evaluateTenantLive({ tenantId: TENANT, assetClass: 'futures', now: NOW });

    expect(second.results[0].decisions.map((d) => d.idempotencyKey)).toEqual(
      first.results[0].decisions.map((d) => d.idempotencyKey)
    );
  });

  it('does not re-evaluate an account another asset class already claimed', async () => {
    activePackMock.mockResolvedValue(storedPack());
    tenantDbMock.mockReturnValue(
      db({
        accounts: [
          { id: ACCOUNT_A, login: '1001', phase: 'funded', account_size: 100000, balance: 98500, equity: 98500 },
        ],
        trades: [],
      })
    );

    const result = await evaluateTenantLive({
      tenantId: TENANT,
      assetClass: 'forex',
      now: NOW,
      excludeAccountIds: new Set([ACCOUNT_A]),
    });

    expect(result.results).toEqual([]);
    expect(result.skippedAccounts).toBe(1);
  });
});

describe('persistBreachDecisions', () => {
  function decision(key: string): BreachDecision {
    return {
      ruleId: 'daily_loss',
      accountId: ACCOUNT_A,
      action: 'terminate',
      exceededBy: 500,
      evidence: {
        limit: 'Daily loss limit of $1000.00',
        observed: '$1500.00 lost on the 2026-03-02 session',
        math: '1500 − 1000 = 500',
        tradeIds: [],
        sessionDay: '2026-03-02',
        values: { limit: 1000, loss: 1500 },
      },
      idempotencyKey: key,
    };
  }

  function persistDb(existing: Array<{ id: string; idempotency_key: string }>) {
    const inserted: Array<Record<string, unknown>[]> = [];
    return {
      inserted,
      handle: {
        tenantId: TENANT,
        select: () => rows(existing),
        insert: (_table: string, payload: Record<string, unknown> | Record<string, unknown>[]) => {
          const batch = Array.isArray(payload) ? payload : [payload];
          inserted.push(batch);
          return rows(
            batch.map((r, i) => ({ id: `decision-${i + 1}`, idempotency_key: r.idempotency_key }))
          );
        },
      },
    };
  }

  it('counts rows written, not attempts, and maps every key to its decision id', async () => {
    const { handle, inserted } = persistDb([]);
    tenantDbMock.mockReturnValue(handle);

    const result = await persistBreachDecisions(TENANT, storedPack(), [
      decision('key-1'),
      decision('key-2'),
    ]);

    expect(result.inserted).toBe(2);
    expect(result.alreadyRecorded).toBe(0);
    expect([...result.idByKey.keys()].sort()).toEqual(['key-1', 'key-2']);

    const row = inserted[0][0];
    expect(row.enforced).toBe(true);
    expect(row.rule_pack_id).toBe('pack-1');
    expect(row.rule_pack_version).toBe(2);
    expect(row.session_day).toBe('2026-03-02');
  });

  it('writes nothing on an identical re-run and says so', async () => {
    const { handle, inserted } = persistDb([
      { id: 'decision-existing', idempotency_key: 'key-1' },
    ]);
    tenantDbMock.mockReturnValue(handle);

    const result = await persistBreachDecisions(TENANT, storedPack(), [decision('key-1')]);

    expect(result.inserted).toBe(0);
    expect(result.alreadyRecorded).toBe(1);
    expect(result.idByKey.get('key-1')).toBe('decision-existing');
    expect(inserted).toHaveLength(0);
  });

  it('collapses a decision the engine emitted twice with the same key', async () => {
    const { handle, inserted } = persistDb([]);
    tenantDbMock.mockReturnValue(handle);

    const result = await persistBreachDecisions(TENANT, storedPack(), [
      decision('key-1'),
      decision('key-1'),
    ]);

    expect(result.inserted).toBe(1);
    expect(inserted[0]).toHaveLength(1);
  });

  it('keeps `indeterminate` on the persisted evidence', async () => {
    const { handle, inserted } = persistDb([]);
    tenantDbMock.mockReturnValue(handle);

    const undecided = { ...decision('key-1'), indeterminate: { reason: 'no snapshots' } };
    await persistBreachDecisions(TENANT, storedPack(), [undecided]);

    const evidence = inserted[0][0].evidence_json as Record<string, unknown>;
    expect(evidence.indeterminate).toEqual({ reason: 'no snapshots' });
  });
});
