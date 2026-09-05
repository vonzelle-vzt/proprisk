import { beforeEach, describe, expect, it, vi } from 'vitest';

// Live mode: the persistence path must actually run. (The demo assertions
// below exercise `buildDemoViolationReport`, which never touches a database
// regardless of this flag.)
vi.mock('@/lib/demo', () => ({ DEMO_MODE: false }));

const logAuditEventMock = vi.fn();
vi.mock('@/lib/audit/chain', () => ({
  logAuditEvent: (...args: unknown[]) => logAuditEventMock(...args),
}));

import {
  assembleViolationReport,
  buildViolationReport,
  canonicalJson,
  contentHashOf,
  getLatestViolationReport,
  legacyLimitSentence,
  listViolationReportsForAccount,
  type ReportDb,
  type ViolationReportSources,
} from './build';
import { buildDemoViolationReport } from './demo';
import { buildViolations } from '@/lib/mock/builders';

// ---------------------------------------------------------------------------
// An in-memory stand-in for the Supabase query builder.
//
// Hand-rolled rather than mocked at the supabase-js boundary because the thing
// under test is the ASSEMBLY and the idempotency, and a fake that actually
// stores rows is the only way to assert that a second build reuses the first
// one's row instead of writing a near-duplicate.
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

class FakeQuery implements PromiseLike<{ data: any; error: null }> {
  private preds: Array<(r: Row) => boolean> = [];
  private ord: { col: string; asc: boolean } | null = null;
  private lim: number | null = null;
  private single = false;

  constructor(private rows: Row[]) {}

  eq(col: string, val: unknown) {
    this.preds.push((r) => String(r[col]) === String(val));
    return this;
  }
  neq(col: string, val: unknown) {
    this.preds.push((r) => String(r[col]) !== String(val));
    return this;
  }
  in(col: string, vals: unknown[]) {
    const set = new Set(vals.map(String));
    this.preds.push((r) => set.has(String(r[col])));
    return this;
  }
  gte(col: string, val: unknown) {
    this.preds.push((r) => String(r[col]) >= String(val));
    return this;
  }
  lt(col: string, val: unknown) {
    this.preds.push((r) => String(r[col]) < String(val));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.ord = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  select(_columns?: string) {
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }

  private result() {
    let out = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.ord) {
      const { col, asc } = this.ord;
      out = [...out].sort((a, b) => {
        const x = String(a[col] ?? '');
        const y = String(b[col] ?? '');
        return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
      });
    }
    if (this.lim !== null) out = out.slice(0, this.lim);
    return { data: this.single ? (out[0] ?? null) : out, error: null as null };
  }

  then<A, B>(
    onOk?: ((v: { data: any; error: null }) => A | PromiseLike<A>) | null,
    onErr?: ((e: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return Promise.resolve(this.result()).then(onOk, onErr);
  }
}

function fakeDb(store: Record<string, Row[]>, tenantId = TENANT): ReportDb & { store: typeof store } {
  let seq = 0;
  return {
    tenantId,
    store,
    from: (table: string) => new FakeQuery(store[table] ?? []),
    insert: (table: string, rows: Row | Row[]) => {
      const list = (Array.isArray(rows) ? rows : [rows]).map((r) => ({
        id: `row-${(seq += 1)}`,
        tenant_id: tenantId,
        ...r,
      }));
      store[table] = [...(store[table] ?? []), ...list];
      return {
        select: () => Promise.resolve({ data: list, error: null }),
      } as any;
    },
    update: (table: string, patch: Row) => ({
      eq: (col: string, val: unknown) => {
        for (const row of store[table] ?? []) {
          if (String(row[col]) === String(val)) Object.assign(row, patch);
        }
        return Promise.resolve({ data: null, error: null });
      },
    }),
  };
}

const TENANT = '11111111-1111-1111-1111-111111111111';
const VIOLATION_ID = '22222222-2222-2222-2222-222222222222';
const ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
const TRADE_ID = '44444444-4444-4444-4444-444444444444';
const PACK_ID = '55555555-5555-5555-5555-555555555555';
const DECISION_ID = '66666666-6666-6666-6666-666666666666';

const RULE_PACK_EVIDENCE = {
  limit: 'maximum daily loss of $5,000.00 (5.00% of the $100,000.00 starting balance)',
  observed: 'lost $6,000.00 across 4 trades on the 2026-03-02 session',
  math: 'peak equity $102,500.00 - closing equity $96,500.00 = $6,000.00 against a $5,000.00 limit',
  tradeIds: [TRADE_ID],
  sessionDay: '2026-03-02',
  values: { peakEquity: 102500, closingEquity: 96500, exceededBy: 1000 },
};

function baseStore(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    violations: [
      {
        id: VIOLATION_ID,
        tenant_id: TENANT,
        account_id: ACCOUNT_ID,
        violation_type: 'daily_loss',
        detected_at: '2026-03-02T21:05:00.000Z',
        status: 'detected',
        severity: 'critical',
        deduction_amount: 0,
        phase: 'funded',
        challenge_type: 'pro',
        account_size: 100000,
        related_trade_ids: [TRADE_ID],
        details_json: {
          source: 'rule_pack',
          rule_pack_id: PACK_ID,
          rule_pack_version: 3,
          rule_pack_content_hash: 'packhash123',
          rule_id: 'daily_loss',
          action: 'terminate',
          evidence: RULE_PACK_EVIDENCE,
          idempotency_key: 'idem-1',
          breach_decision_id: DECISION_ID,
        },
      },
    ],
    accounts: [
      {
        id: ACCOUNT_ID,
        tenant_id: TENANT,
        login: '1001',
        trader_name: 'Maria Garcia',
        phase: 'funded',
        challenge_type: 'pro',
        account_size: 100000,
        balance: 96500,
        equity: 96500,
        starting_day_balance: 102500,
        starting_day_equity: 102500,
      },
    ],
    trades: [
      {
        id: TRADE_ID,
        tenant_id: TENANT,
        account_id: ACCOUNT_ID,
        trade_id_external: 'T-9001',
        symbol: 'EURUSD',
        direction: 'buy',
        lot_size: 2.5,
        open_price: 1.0812,
        close_price: 1.0765,
        open_time: '2026-03-02T14:00:00.000Z',
        close_time: '2026-03-02T15:30:00.000Z',
        profit: -6000,
      },
    ],
    deductions: [],
    emails: [],
    enforcement_queue: [],
    breach_decisions: [
      {
        id: DECISION_ID,
        tenant_id: TENANT,
        rule_pack_id: PACK_ID,
        rule_pack_version: 3,
        account_id: ACCOUNT_ID,
        rule_id: 'daily_loss',
        action: 'terminate',
        exceeded_by: 1000,
        session_day: '2026-03-02',
        evidence_json: RULE_PACK_EVIDENCE,
        idempotency_key: 'idem-1',
      },
    ],
    rule_packs: [
      {
        id: PACK_ID,
        tenant_id: TENANT,
        name: 'House rules',
        version: 3,
        asset_class: 'forex',
        content_hash: 'packhash123',
        pack_json: { rules: { daily_loss: { threshold: { type: 'pct_of_initial', value: 0.05 } } } },
      },
    ],
    evidence_packs: [],
    disputes: [],
    equity_snapshots: [],
    violation_reports: [],
    ...overrides,
  } as Record<string, Row[]>;
}

beforeEach(() => {
  vi.clearAllMocks();
  logAuditEventMock.mockResolvedValue('audit-hash-abc');
});

// ---------------------------------------------------------------------------

describe('canonical hashing', () => {
  it('is insensitive to key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: 2 } })).toBe('{"a":{"c":2},"b":1}');
  });

  it('ignores the report identity fields, so the same facts hash the same', async () => {
    const db = fakeDb(baseStore());
    const first = await buildViolationReport({
      tenantId: TENANT,
      violationId: VIOLATION_ID,
      actor: 'dana@firm.com',
      db,
      now: new Date('2026-03-03T09:00:00.000Z'),
    });

    const relabelled = {
      ...first.record.report,
      reportId: 'a-different-id',
      generatedAt: '2027-01-01T00:00:00.000Z',
      generatedBy: 'someone-else@firm.com',
    };
    expect(contentHashOf(relabelled)).toBe(contentHashOf(first.record.report));
  });
});

describe('buildViolationReport — rule-pack findings', () => {
  it('quotes the stored evidence limit / observed / math verbatim', async () => {
    const db = fakeDb(baseStore());
    const { record } = await buildViolationReport({
      tenantId: TENANT,
      violationId: VIOLATION_ID,
      actor: 'dana@firm.com',
      db,
      now: new Date('2026-03-03T09:00:00.000Z'),
    });
    const report = record.report;

    expect(report.rule.source).toBe('rule_pack');
    expect(report.rule.limitAsWritten).toBe(RULE_PACK_EVIDENCE.limit);
    expect(report.whatHappened.observed).toBe(RULE_PACK_EVIDENCE.observed);
    expect(report.arithmetic[0]).toEqual({
      label: 'Breach arithmetic',
      expression: RULE_PACK_EVIDENCE.math,
      value: '',
    });
    // The pinned pack, not "whatever is active now".
    expect(report.rule.pack).toEqual({
      id: PACK_ID,
      name: 'House rules',
      version: 3,
      contentHash: 'packhash123',
    });
    expect(report.whatHappened.exceededBy).toBe(1000);
    expect(report.whatHappened.sessionDay).toBe('2026-03-02');
    expect(report.provenance.sourceRows.breachDecision).toBe(true);
  });

  it('cites the trades named by related_trade_ids', async () => {
    const db = fakeDb(baseStore());
    const { record } = await buildViolationReport({
      tenantId: TENANT,
      violationId: VIOLATION_ID,
      actor: 'dana@firm.com',
      db,
      now: new Date('2026-03-03T09:00:00.000Z'),
    });

    expect(record.report.trades).toHaveLength(1);
    expect(record.report.trades[0]).toMatchObject({
      id: 'T-9001',
      symbol: 'EURUSD',
      side: 'buy',
      volume: 2.5,
      pnl: -6000,
      flagged: true,
    });
  });

  it('records the audit chain entry AFTER the row lands, and stores its hash', async () => {
    const store = baseStore();
    const db = fakeDb(store);
    const { record } = await buildViolationReport({
      tenantId: TENANT,
      violationId: VIOLATION_ID,
      actor: 'dana@firm.com',
      db,
      now: new Date('2026-03-03T09:00:00.000Z'),
    });

    expect(store.violation_reports).toHaveLength(1);
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action_type: 'violation_report_generated',
        entity_type: 'violation',
        entity_id: VIOLATION_ID,
        performed_by: 'dana@firm.com',
        details: expect.objectContaining({ content_hash: record.contentHash }),
      })
    );
    expect(store.violation_reports[0].audit_hash).toBe('audit-hash-abc');
    expect(record.auditHash).toBe('audit-hash-abc');
    expect(record.report.provenance.auditHash).toBe('audit-hash-abc');
  });
});

describe('buildViolationReport — idempotency by input', () => {
  it('reuses the existing row on a second build with unchanged facts', async () => {
    const store = baseStore();
    const db = fakeDb(store);

    const first = await buildViolationReport({
      tenantId: TENANT,
      violationId: VIOLATION_ID,
      actor: 'dana@firm.com',
      db,
      now: new Date('2026-03-03T09:00:00.000Z'),
    });
    // A different instant and a different human: still the same FACTS.
    const second = await buildViolationReport({
      tenantId: TENANT,
      violationId: VIOLATION_ID,
      actor: 'sam@firm.com',
      db,
      now: new Date('2026-06-01T12:00:00.000Z'),
    });

    expect(first.unchanged).toBe(false);
    expect(second.unchanged).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.contentHash).toBe(first.record.contentHash);
    expect(store.violation_reports).toHaveLength(1);
    // No second audit entry for a write that did not happen.
    expect(logAuditEventMock).toHaveBeenCalledTimes(1);
  });

  it('writes a SECOND row when the underlying facts change', async () => {
    const store = baseStore();
    const db = fakeDb(store);

    await buildViolationReport({
      tenantId: TENANT,
      violationId: VIOLATION_ID,
      actor: 'dana@firm.com',
      db,
      now: new Date('2026-03-03T09:00:00.000Z'),
    });

    store.deductions.push({
      id: 'ded-1',
      tenant_id: TENANT,
      violation_id: VIOLATION_ID,
      account_id: ACCOUNT_ID,
      amount: 6000,
      pre_balance: 102500,
      post_balance: 96500,
      executed_by: 'dana@firm.com',
      reason: 'Daily loss breach',
      executed_at: '2026-03-04T10:00:00.000Z',
    });

    const second = await buildViolationReport({
      tenantId: TENANT,
      violationId: VIOLATION_ID,
      actor: 'dana@firm.com',
      db,
      now: new Date('2026-03-04T11:00:00.000Z'),
    });

    expect(second.unchanged).toBe(false);
    expect(store.violation_reports).toHaveLength(2);
    expect(second.record.report.action.deduction).toEqual({
      amount: 6000,
      preBalance: 102500,
      postBalance: 96500,
      executedBy: 'dana@firm.com',
    });
  });

  it('getLatestViolationReport returns the newest row and listForAccount finds it', async () => {
    const store = baseStore();
    const db = fakeDb(store);
    await buildViolationReport({
      tenantId: TENANT,
      violationId: VIOLATION_ID,
      actor: 'dana@firm.com',
      db,
      now: new Date('2026-03-03T09:00:00.000Z'),
    });

    const latest = await getLatestViolationReport(TENANT, VIOLATION_ID, db);
    expect(latest?.violationId).toBe(VIOLATION_ID);

    const forAccount = await listViolationReportsForAccount(TENANT, ACCOUNT_ID, db);
    expect(forAccount).toHaveLength(1);
    expect(forAccount[0].accountId).toBe(ACCOUNT_ID);
  });

  it('rejects a violation that does not belong to the tenant handle', async () => {
    const db = fakeDb(baseStore({ violations: [] }));
    await expect(
      buildViolationReport({
        tenantId: TENANT,
        violationId: VIOLATION_ID,
        actor: 'dana@firm.com',
        db,
      })
    ).rejects.toThrow(/not found/i);
  });
});

describe('data fidelity', () => {
  it('says so when no equity snapshots were retained for the session day', async () => {
    const db = fakeDb(baseStore());
    const { record } = await buildViolationReport({
      tenantId: TENANT,
      violationId: VIOLATION_ID,
      actor: 'dana@firm.com',
      db,
      now: new Date('2026-03-03T09:00:00.000Z'),
    });

    expect(record.report.provenance.dataFidelity).toEqual(
      expect.arrayContaining([expect.stringContaining('No equity snapshots retained')])
    );
  });

  it('flags unknown sampling fidelity rather than implying certainty', async () => {
    const store = baseStore({
      equity_snapshots: [
        {
          id: 's1',
          tenant_id: TENANT,
          account_id: ACCOUNT_ID,
          captured_at: '2026-03-02T14:10:00.000Z',
          balance: 102500,
          equity: 102500,
          sample_interval_seconds: null,
        },
      ],
    });
    const { record } = await buildViolationReport({
      tenantId: TENANT,
      violationId: VIOLATION_ID,
      actor: 'dana@firm.com',
      db: fakeDb(store),
      now: new Date('2026-03-03T09:00:00.000Z'),
    });

    expect(record.report.provenance.dataFidelity).toEqual(
      expect.arrayContaining([expect.stringContaining('Equity sampling interval unknown')])
    );
  });

  it('states the coarsest observed interval when the fidelity IS known', async () => {
    const store = baseStore({
      equity_snapshots: [
        {
          id: 's1',
          tenant_id: TENANT,
          account_id: ACCOUNT_ID,
          captured_at: '2026-03-02T14:10:00.000Z',
          balance: 102500,
          equity: 102500,
          sample_interval_seconds: 60,
        },
      ],
    });
    const { record } = await buildViolationReport({
      tenantId: TENANT,
      violationId: VIOLATION_ID,
      actor: 'dana@firm.com',
      db: fakeDb(store),
      now: new Date('2026-03-03T09:00:00.000Z'),
    });

    expect(record.report.provenance.dataFidelity).toEqual(
      expect.arrayContaining([expect.stringContaining('no finer than every 60s')])
    );
    expect(record.report.timeline.some((t) => t.kind === 'equity_sample')).toBe(true);
  });
});

describe('legacy-engine findings', () => {
  it('derives the limit from src/config/violations.ts when no evidence was stored', async () => {
    const store = baseStore({
      breach_decisions: [],
      rule_packs: [],
      violations: [
        {
          id: VIOLATION_ID,
          tenant_id: TENANT,
          account_id: ACCOUNT_ID,
          violation_type: 'hft',
          detected_at: '2026-03-02T21:05:00.000Z',
          status: 'detected',
          severity: 'high',
          deduction_amount: 1250.5,
          phase: 'funded',
          challenge_type: 'pro',
          account_size: 100000,
          related_trade_ids: [],
          // The sparse shape older rows carry.
          details_json: { flagged_trades: 7 },
        },
      ],
    });

    const { record } = await buildViolationReport({
      tenantId: TENANT,
      violationId: VIOLATION_ID,
      actor: 'dana@firm.com',
      db: fakeDb(store),
      now: new Date('2026-03-03T09:00:00.000Z'),
    });
    const report = record.report;

    expect(report.rule.source).toBe('legacy_engine');
    expect(report.rule.limitAsWritten).toBe(legacyLimitSentence('hft', { accountSize: 100000 }));
    expect(report.rule.limitAsWritten).toContain('2 trades in 3s');
    expect(report.provenance.dataFidelity).toEqual(
      expect.arrayContaining([
        expect.stringContaining('legacy engine'),
        expect.stringContaining('predates structured breach evidence'),
      ])
    );
    expect(report.arithmetic).toEqual(
      expect.arrayContaining([{ label: 'Deduction recommended', value: '$1,250.50' }])
    );
  });
});

describe('assembleViolationReport is pure', () => {
  it('produces identical bytes for identical sources', () => {
    const sources: ViolationReportSources = {
      violation: baseStore().violations[0],
      account: baseStore().accounts[0],
      trades: baseStore().trades,
      deductions: [],
      emails: [],
      queueEntry: null,
      breachDecision: null,
      evidencePack: null,
      rulePack: null,
      priorViolations: [],
      disputes: [],
      snapshots: [],
    };
    const opts = { reportId: 'r1', generatedAt: '2026-03-03T09:00:00.000Z', generatedBy: 'x' };

    expect(canonicalJson(assembleViolationReport(sources, opts))).toBe(
      canonicalJson(assembleViolationReport(sources, opts))
    );
  });
});

describe('buildDemoViolationReport', () => {
  const demoId = buildViolations('forex', 1, 1).data[0].id as string;

  it('resolves a mock violation id and fills every section', () => {
    const report = buildDemoViolationReport(demoId);
    expect(report).not.toBeNull();
    const r = report!;

    expect(r.schemaVersion).toBe(1);
    expect(r.reportId).toBe(`demo-${demoId}`);
    expect(r.header.login).toBeTruthy();
    expect(r.rule.label).toBeTruthy();
    expect(r.rule.limitAsWritten).toBeTruthy();
    expect(r.rule.source).toBe('legacy_engine');
    expect(r.whatHappened.observed).toBeTruthy();
    expect(r.arithmetic.length).toBeGreaterThan(0);
    expect(r.timeline.length).toBeGreaterThan(0);
    expect(r.accountSnapshot.startingBalance).toBeGreaterThan(0);
    expect(r.action).toEqual({});
    expect(r.history.disputes).toEqual([]);
    expect(r.provenance.dataFidelity.length).toBeGreaterThan(0);
    expect(r.provenance.sourceRows).toEqual({
      violation: true,
      breachDecision: false,
      evidencePack: false,
      enforcementQueue: false,
    });
  });

  it('fabricates no approver, deduction execution or audit hash', () => {
    const r = buildDemoViolationReport(demoId)!;
    expect(r.action.approver).toBeUndefined();
    expect(r.action.deduction).toBeUndefined();
    expect(r.provenance.auditHash).toBeUndefined();
    expect(r.provenance.generatedNarrative).toBeUndefined();
  });

  it('returns null for an id the mock dataset does not have', () => {
    expect(buildDemoViolationReport('nope-nothing')).toBeNull();
  });
});
