import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * These tests run the REAL rule-pack engine, the real `evaluateTenantLive`
 * assembly and the real `recordViolation` against an in-memory stand-in for
 * Postgres. Only the outside world is mocked (the provider, the evidence
 * builder, the notifier), because the thing under test is the chain — decision
 * → breach_decisions → violations → enforcement_queue — and mocking any link in
 * it would prove nothing.
 *
 * The fake database carries the two unique constraints that make the chain
 * idempotent (breach_decisions' (tenant, key, enforced) and 00026's partial
 * index on violations.details_json->>idempotency_key), so "the second run
 * changes nothing" is verified against the same rule the database enforces
 * rather than against the application's own read-before-write.
 */

const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACCOUNT_A = 'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TRADE_1 = 'ccc11111-cccc-4ccc-8ccc-cccccccccccc';
const TRADE_2 = 'ccc22222-cccc-4ccc-8ccc-cccccccccccc';
const TRADE_3 = 'ccc33333-cccc-4ccc-8ccc-cccccccccccc';

/**
 * The clock is frozen because the route reads it exactly once and threads the
 * value down as `now` — every lookback window, session-day bucket and expiry
 * derives from it. Freezing it is what makes "the same tape produces the same
 * decisions" an assertion rather than a hope, and it keeps the fixture trades
 * inside the live lookback window forever.
 */
const NOW = new Date('2026-03-10T22:00:00Z');

// ---------------------------------------------------------------------------
// In-memory Postgres stand-in
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

class Store {
  tables: Record<string, Row[]> = {};
  /** Insert order, so "the violation exists before the queue row" is testable. */
  ops: string[] = [];
  seq = 0;

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  count(table: string): number {
    return this.rows(table).length;
  }
}

let store: Store;

function readColumn(row: Row, column: string): unknown {
  const json = /^(\w+)->>(\w+)$/.exec(column);
  if (json) return row[json[1]]?.[json[2]];
  return row[column];
}

/** The unique constraints this chain's idempotency actually rests on. */
function uniqueConflict(table: string, row: Row): boolean {
  if (table === 'violations') {
    const key = row.details_json?.idempotency_key;
    if (!key) return false;
    return store
      .rows(table)
      .some((r) => r.tenant_id === row.tenant_id && r.details_json?.idempotency_key === key);
  }
  if (table === 'breach_decisions') {
    return store
      .rows(table)
      .some(
        (r) =>
          r.tenant_id === row.tenant_id &&
          r.idempotency_key === row.idempotency_key &&
          r.enforced === row.enforced
      );
  }
  if (table === 'accounts') {
    return store.rows(table).some((r) => r.tenant_id === row.tenant_id && r.login === row.login);
  }
  return false;
}

function makeSelect(table: string, tenantId: string | null) {
  const filters: Array<{ op: string; col: string; val: any }> = [];
  let lim = Infinity;

  const run = () => {
    const data = store
      .rows(table)
      .filter((r) => tenantId === null || r.tenant_id === tenantId)
      .filter((r) =>
        filters.every((f) => {
          const actual = readColumn(r, f.col);
          if (f.op === 'eq') return actual === f.val;
          if (f.op === 'in') return (f.val as unknown[]).includes(actual);
          if (f.op === 'gte') return String(actual) >= String(f.val);
          if (f.op === 'lte') return String(actual) <= String(f.val);
          return true;
        })
      )
      .slice(0, lim)
      .map((r) => ({ ...r }));
    return { data, error: null };
  };

  const builder: any = {
    eq: (col: string, val: any) => (filters.push({ op: 'eq', col, val }), builder),
    in: (col: string, val: any) => (filters.push({ op: 'in', col, val }), builder),
    gte: (col: string, val: any) => (filters.push({ op: 'gte', col, val }), builder),
    lte: (col: string, val: any) => (filters.push({ op: 'lte', col, val }), builder),
    order: () => builder,
    limit: (n: number) => ((lim = n), builder),
    returns: () => builder,
    single: async () => {
      const { data } = run();
      return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: 'no rows' } };
    },
    maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
    then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
  };
  return builder;
}

function makeInsert(table: string, rows: Row[], tenantId: string) {
  const stamped = rows.map((r) => ({ ...r, tenant_id: tenantId, id: r.id ?? `${table}-${++store.seq}` }));
  const written: Row[] = [];
  let error: Row | null = null;

  for (const row of stamped) {
    if (uniqueConflict(table, row)) {
      error = { message: 'duplicate key value violates unique constraint', code: '23505' };
      break;
    }
    store.rows(table).push(row);
    store.ops.push(`${table}:${row.id}`);
    written.push(row);
  }

  // A batch insert is all-or-nothing; roll back what landed before the conflict.
  if (error) {
    for (const row of written) {
      store.rows(table).splice(store.rows(table).indexOf(row), 1);
      store.ops.splice(store.ops.indexOf(`${table}:${row.id}`), 1);
    }
    written.length = 0;
  }

  const result = error ? { data: null, error } : { data: written.map((r) => ({ ...r })), error: null };
  const builder: any = {
    select: () => builder,
    returns: () => builder,
    single: async () =>
      error ? { data: null, error } : { data: written[0] ? { ...written[0] } : null, error: null },
    then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
  };
  return builder;
}

function makeUpdate(table: string, patch: Row, tenantId: string) {
  const filters: Array<[string, unknown]> = [];
  const builder: any = {
    eq: (col: string, val: unknown) => (filters.push([col, val]), builder),
    then: (res: any, rej: any) => {
      for (const row of store.rows(table)) {
        if (row.tenant_id !== tenantId) continue;
        if (!filters.every(([c, v]) => readColumn(row, c) === v)) continue;
        Object.assign(row, patch);
      }
      return Promise.resolve({ data: null, error: null }).then(res, rej);
    },
  };
  return builder;
}

function fakeTenantDb(tenantId: string) {
  return {
    tenantId,
    from: (table: string) => makeSelect(table, tenantId),
    select: (table: string, _columns?: string) => makeSelect(table, tenantId),
    insert: (table: string, rows: Row | Row[]) =>
      makeInsert(table, Array.isArray(rows) ? rows : [rows], tenantId),
    update: (table: string, patch: Row) => {
      const { tenant_id: _discarded, ...safe } = patch;
      return makeUpdate(table, safe, tenantId);
    },
  };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const activePackMock = vi.fn();
const fetchAccountsToMonitorMock = vi.fn();
const fetchAccountDetailsMock = vi.fn();
const fetchUserDetailsMock = vi.fn();
const runLocalViolationAnalysisMock = vi.fn();
const buildEvidencePackMock = vi.fn();
const notifyBreachMock = vi.fn();
const logAuditEventMock = vi.fn();

vi.mock('@/lib/db/tenant-scoped', () => ({
  tenantDb: (tenantId: string) => fakeTenantDb(tenantId),
  globalTable: (table: string) => ({ select: () => makeSelect(table, null) }),
  listActiveTenantIds: async () => [TENANT],
}));

vi.mock('@/lib/ingest/snapshots', () => ({
  // No snapshot ingestion for these accounts — which is the point of the
  // `skipped` assertions below.
  loadEquitySnapshots: async () => [],
}));

vi.mock('@/lib/rulepack/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rulepack/store')>();
  return { ...actual, activePack: (...args: unknown[]) => activePackMock(...args) };
});

vi.mock('@/lib/platform/client', () => ({
  fetchAccountsToMonitor: (...a: unknown[]) => fetchAccountsToMonitorMock(...a),
  fetchAccountDetails: (...a: unknown[]) => fetchAccountDetailsMock(...a),
  fetchUserDetails: (...a: unknown[]) => fetchUserDetailsMock(...a),
}));

vi.mock('@/lib/payouts/local-analysis', () => ({
  runLocalViolationAnalysis: (...a: unknown[]) => runLocalViolationAnalysisMock(...a),
}));

vi.mock('@/lib/evidence/builder', () => ({
  buildEvidencePack: (...a: unknown[]) => buildEvidencePackMock(...a),
}));

vi.mock('@/lib/alerts/notice', () => ({ draftTraderNotice: () => 'drafted notice' }));

vi.mock('@/lib/notify/webhook', () => ({ notifyBreach: (...a: unknown[]) => notifyBreachMock(...a) }));

vi.mock('@/lib/deductions/audit', () => ({ logAuditEvent: (...a: unknown[]) => logAuditEventMock(...a) }));

vi.mock('@/lib/logging/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  cronMetrics: vi.fn(),
}));

import { GET } from './route';
import { parseRulePack } from '@/lib/rulepack/schema';
import type { StoredRulePack } from '@/lib/rulepack/store';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CRON_SECRET = 'test-secret';

/**
 * Two rules, chosen so one run exercises both halves of the honesty contract:
 * `daily_loss` fires from the trade tape, and `drawdown` cannot be evaluated at
 * all without intraday snapshots and must therefore be reported as skipped
 * rather than as "no breach".
 */
function storedPack(): StoredRulePack {
  const { pack, validation } = parseRulePack({
    schema_version: 1,
    asset_class: 'futures',
    name: 'Detection test pack',
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

  return {
    id: 'pack-1',
    tenantId: TENANT,
    name: 'Detection test pack',
    assetClass: 'futures',
    version: 2,
    status: 'active',
    pack,
    contentHash: 'content-hash-1',
    derivedFrom: null,
    approvedBy: 'risk@firm.test',
    approvedAt: '2026-03-01T00:00:00Z',
    createdAt: '2026-03-01T00:00:00Z',
  };
}

/**
 * Account A loses $1,500 on the 2026-03-02 session and $2,000 on 2026-03-03 —
 * two breaches of a $1,000 daily limit. Account B loses $100 and breaches
 * nothing, so a clean account must not produce a decision.
 */
function seedBook(): void {
  store.rows('accounts').push(
    {
      id: ACCOUNT_A,
      tenant_id: TENANT,
      login: '1001',
      phase: 'funded',
      challenge_type: 'pro',
      account_size: 100000,
      balance: 96500,
      equity: 96500,
      is_active: true,
    },
    {
      id: ACCOUNT_B,
      tenant_id: TENANT,
      login: '1002',
      phase: 'funded',
      challenge_type: 'pro',
      account_size: 100000,
      balance: 99900,
      equity: 99900,
      is_active: true,
    }
  );

  store.rows('trades').push(
    {
      id: TRADE_1,
      tenant_id: TENANT,
      account_id: ACCOUNT_A,
      symbol: 'ES',
      asset_class: 'indices',
      open_time: '2026-03-02T14:00:00Z',
      close_time: '2026-03-02T15:00:00Z',
      profit: '-1500',
      lot_size: '2',
    },
    {
      id: TRADE_2,
      tenant_id: TENANT,
      account_id: ACCOUNT_A,
      symbol: 'ES',
      asset_class: 'indices',
      open_time: '2026-03-03T14:00:00Z',
      close_time: '2026-03-03T15:00:00Z',
      profit: '-2000',
      lot_size: '2',
    },
    {
      id: TRADE_3,
      tenant_id: TENANT,
      account_id: ACCOUNT_B,
      symbol: 'ES',
      asset_class: 'indices',
      open_time: '2026-03-02T14:00:00Z',
      close_time: '2026-03-02T15:00:00Z',
      profit: '-100',
      lot_size: '1',
    }
  );
}

function request(secret = CRON_SECRET): Request {
  return new Request('https://app.test/api/cron/detect-violations', {
    headers: { authorization: `Bearer ${secret}` },
  });
}

async function runCron() {
  const response = await GET(request());
  const body = await response.json();
  return { response, results: body.results };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  store = new Store();
  process.env.CRON_SECRET = CRON_SECRET;

  activePackMock.mockImplementation(async (_tenantId: string, assetClass: string) =>
    assetClass === 'futures' ? storedPack() : null
  );
  // Legacy path off unless a test turns it on.
  fetchAccountsToMonitorMock.mockResolvedValue([]);
  buildEvidencePackMock.mockResolvedValue({ id: 'evidence-pack-1' });
  notifyBreachMock.mockResolvedValue(undefined);
  logAuditEventMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/cron/detect-violations — auth', () => {
  it('rejects a request without the cron secret', async () => {
    const response = await GET(request('wrong'));
    expect(response.status).toBe(401);
  });
});

describe('rule-pack detection', () => {
  it('leaves a decision, a linked violation and a queue item for every breach', async () => {
    seedBook();
    const { results } = await runCron();

    // Two session days over the $1,000 limit on account A; account B is clean.
    expect(store.count('breach_decisions')).toBe(2);
    expect(store.count('violations')).toBe(2);
    expect(store.count('enforcement_queue')).toBe(2);

    expect(results.decisions_persisted).toBe(2);
    expect(results.decisions_already_recorded).toBe(0);
    expect(results.violations_created).toBe(2);
    expect(results.enforcement_queued).toBe(2);
    expect(results.accounts_evaluated).toBe(2);
    expect(results.rule_pack).toEqual({
      futures: { none_active: 0, evaluated: 1 },
      forex: { none_active: 1, evaluated: 0 },
    });

    for (const decision of store.rows('breach_decisions')) {
      expect(decision.enforced).toBe(true);
      expect(decision.account_id).toBe(ACCOUNT_A);
      expect(decision.rule_id).toBe('daily_loss');
      expect(decision.rule_pack_id).toBe('pack-1');
      expect(decision.rule_pack_version).toBe(2);
      expect(decision.session_day).toMatch(/^2026-03-0[23]$/);
    }
  });

  it('links each violation back to its decision and its pack version', async () => {
    seedBook();
    await runCron();

    const decisionIds = new Set(store.rows('breach_decisions').map((d) => d.id));
    for (const violation of store.rows('violations')) {
      expect(violation.account_id).toBe(ACCOUNT_A);
      expect(violation.violation_type).toBe('daily_loss');
      expect(violation.severity).toBe('critical');
      expect(violation.details_json.source).toBe('rule_pack');
      expect(decisionIds.has(violation.details_json.breach_decision_id)).toBe(true);
      expect(violation.details_json.rule_pack_version).toBe(2);
      expect(violation.details_json.rule_pack_content_hash).toBe('content-hash-1');
      // The arithmetic a dispute turns on travels with the row.
      expect(violation.details_json.evidence.math).toContain('lost against a $1000.00 limit');
      expect(violation.related_trade_ids).toContain(
        violation.details_json.evidence.sessionDay === '2026-03-02' ? TRADE_1 : TRADE_2
      );
    }
  });

  it('maps a terminate action onto a real enforcement action_type and never a deduction', async () => {
    seedBook();
    await runCron();

    const violationIds = new Set(store.rows('violations').map((v) => v.id));
    for (const queued of store.rows('enforcement_queue')) {
      expect(queued.action_type).toBe('account_restriction');
      expect(queued.status).toBe('pending');
      expect(queued.recommended_amount).toBe(0);
      expect(queued.violation_type).toBe('daily_loss');
      expect(violationIds.has(queued.violation_id)).toBe(true);
      expect(queued.recommendation_reason).toMatch(/Daily Loss Limit: .* vs .*/);
      expect(queued.recommendation_details.source).toBe('rule_pack');
      expect(violationIds.has(queued.recommendation_details.violation_id)).toBe(true);
      expect(queued.recommendation_details.rule_pack_id).toBe('pack-1');
      expect(queued.recommendation_details.rule_pack_version).toBe(2);
      expect(queued.recommendation_details.breach_decision_id).toBeTruthy();
      // Evidence pack keyed by the violation, now that the row exists.
      expect(queued.recommendation_details.evidence_pack_id).toBe('evidence-pack-1');
      expect(queued.recommendation_details.notice_draft).toBe('drafted notice');
    }

    expect(buildEvidencePackMock).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: 'violation', accountId: ACCOUNT_A, tenantId: TENANT })
    );
    const subjectIds = buildEvidencePackMock.mock.calls.map((c) => c[0].subjectId);
    expect(subjectIds.every((id) => violationIds.has(id))).toBe(true);
  });

  it('reports a rule it could not evaluate instead of passing it silently', async () => {
    seedBook();
    const { results } = await runCron();

    // Both accounts: trailing_intraday drawdown with no snapshots ingested.
    expect(results.skipped).toHaveLength(2);
    expect(results.skipped_truncated).toBe(0);
    expect(results.skipped.map((s: { account_id: string }) => s.account_id).sort()).toEqual(
      [ACCOUNT_A, ACCOUNT_B].sort()
    );
    for (const entry of results.skipped) {
      expect(entry.rule_id).toBe('drawdown');
      expect(entry.reason).toContain('intraday equity snapshots');
    }

    // A skipped rule is not a breach: nothing was recorded for it.
    expect(store.rows('violations').every((v) => v.violation_type === 'daily_loss')).toBe(true);
  });

  it('a second identical run changes nothing, and says so', async () => {
    seedBook();
    await runCron();

    const decisionsAfterFirst = store.count('breach_decisions');
    const violationsAfterFirst = store.count('violations');
    const queueAfterFirst = store.count('enforcement_queue');

    const { results } = await runCron();

    expect(store.count('breach_decisions')).toBe(decisionsAfterFirst);
    expect(store.count('violations')).toBe(violationsAfterFirst);
    expect(store.count('enforcement_queue')).toBe(queueAfterFirst);

    expect(results.decisions_persisted).toBe(0);
    expect(results.decisions_already_recorded).toBe(2);
    expect(results.violations_created).toBe(0);
    expect(results.violations_already_recorded).toBe(2);
    expect(results.enforcement_queued).toBe(0);
    expect(results.errors).toBe(0);
    // Still evaluated, still honest about what it could not check.
    expect(results.rule_pack.futures.evaluated).toBe(1);
    expect(results.skipped).toHaveLength(2);
  });

  it('a new trading day is a new decision, not a suppressed duplicate', async () => {
    seedBook();
    await runCron();

    store.rows('trades').push({
      id: 'ccc44444-cccc-4ccc-8ccc-cccccccccccc',
      tenant_id: TENANT,
      account_id: ACCOUNT_A,
      symbol: 'ES',
      asset_class: 'indices',
      open_time: '2026-03-04T14:00:00Z',
      close_time: '2026-03-04T15:00:00Z',
      profit: '-3000',
      lot_size: '2',
    });

    const { results } = await runCron();

    expect(results.decisions_persisted).toBe(1);
    expect(results.violations_created).toBe(1);
    expect(results.enforcement_queued).toBe(1);
    expect(store.count('breach_decisions')).toBe(3);
  });

  it('says none_active rather than reporting a clean run when no pack is active', async () => {
    seedBook();
    activePackMock.mockResolvedValue(null);

    const { results } = await runCron();

    expect(results.rule_pack).toEqual({
      futures: { none_active: 1, evaluated: 0 },
      forex: { none_active: 1, evaluated: 0 },
    });
    expect(results.accounts_evaluated).toBe(0);
    expect(store.count('breach_decisions')).toBe(0);
    expect(store.count('violations')).toBe(0);
  });

  it('records a warn as a decision and a violation but queues nothing', async () => {
    seedBook();
    activePackMock.mockImplementation(async (_t: string, assetClass: string) => {
      if (assetClass !== 'futures') return null;
      const pack = storedPack();
      pack.pack.rules.daily_loss!.action = 'warn';
      return pack;
    });

    const { results } = await runCron();

    expect(store.count('breach_decisions')).toBe(2);
    expect(store.count('violations')).toBe(2);
    expect(store.count('enforcement_queue')).toBe(0);
    expect(results.violations_created).toBe(2);
    expect(results.enforcement_queued).toBe(0);
    expect(store.rows('violations').every((v) => v.severity === 'low')).toBe(true);
  });
});

describe('legacy detector path', () => {
  beforeEach(() => {
    activePackMock.mockResolvedValue(null);
    fetchAccountsToMonitorMock.mockResolvedValue([
      { _id: 'p1', accountId: 'platform-77', login: 1001, email: 'trader@firm.test', userId: 42 },
    ]);
    fetchAccountDetailsMock.mockResolvedValue({
      login: 1001,
      startingBalance: 100000,
      planName: 'Pro 100K',
    });
    fetchUserDetailsMock.mockResolvedValue({
      email: 'trader@firm.test',
      firstName: 'A',
      lastName: 'Trader',
    });
    runLocalViolationAnalysisMock.mockResolvedValue({
      mergedBreakdown: { hft: 250 },
      mergedTotal: 250,
      mergedViolationTypes: ['hft'],
      trades: [],
      tradesFetched: true,
      localAnalysis: {
        violations: [
          { type: 'HFT', typeKey: 'hft', trade: { _id: 'pt-1' }, explanation: '', deductionAmount: 250 },
        ],
        summary: {
          totalDeductions: 250,
          violationTypeCount: { hft: 1 },
          violatingTradeCount: 1,
          deductionsByType: { hft: 250 },
        },
        newsEvents: [],
      },
    });
  });

  it('creates the violation before the queue row, and links them', async () => {
    const { results } = await runCron();

    expect(results.total_detected).toBe(1);
    expect(results.hft).toBe(1);
    expect(store.count('violations')).toBe(1);
    expect(store.count('enforcement_queue')).toBe(1);

    const violation = store.rows('violations')[0];
    const queued = store.rows('enforcement_queue')[0];

    // Ordering matters: the queue row must never point at a violation that does
    // not exist yet.
    expect(store.ops.indexOf(`violations:${violation.id}`)).toBeLessThan(
      store.ops.indexOf(`enforcement_queue:${queued.id}`)
    );

    expect(violation.violation_type).toBe('hft');
    expect(violation.deduction_amount).toBe(250);
    expect(violation.details_json.source).toBe('legacy_engine');
    expect(violation.details_json.platform_trade_ids).toEqual(['pt-1']);
    // Platform trade ids are NOT uuids and must not reach the UUID[] column.
    expect(violation.related_trade_ids).toEqual([]);

    expect(queued.violation_id).toBe(violation.id);
    expect(queued.recommendation_details.violation_id).toBe(violation.id);
    expect(queued.action_type).toBe('deduction');
    expect(queued.recommended_amount).toBe(250);
  });

  it('synthesises the accounts row it needs for the FK, and reuses it next run', async () => {
    await runCron();

    expect(store.count('accounts')).toBe(1);
    const account = store.rows('accounts')[0];
    expect(account.login).toBe('1001');
    expect(account.user_profile_id).toBe('42');
    expect(account.account_size).toBe(100000);

    await runCron();
    // No second synthesis, and no duplicate finding.
    expect(store.count('accounts')).toBe(1);
    expect(store.count('violations')).toBe(1);
    expect(store.count('enforcement_queue')).toBe(1);
  });

  it('is idempotent by input, not by clock', async () => {
    await runCron();
    const { results } = await runCron();

    expect(results.violations_created).toBe(0);
    expect(results.violations_already_recorded).toBe(1);
    expect(results.enforcement_queued).toBe(0);
    expect(results.errors).toBe(0);
  });
});
