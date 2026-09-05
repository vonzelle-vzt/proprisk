import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logging/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { legacyFindingKey, recordViolation } from './record';
import type { BreachEvidence } from '@/lib/rulepack/types';

const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACCOUNT_UUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const EVIDENCE: BreachEvidence = {
  limit: 'Daily loss limit of $1000.00, measured on balance',
  observed: '$1500.00 lost on the 2026-03-02 session',
  math: 'realised −1500.00 against a 1000.00 limit',
  tradeIds: ['cccccccc-cccc-cccc-cccc-cccccccccccc', 'not-a-uuid'],
  sessionDay: '2026-03-02',
  values: { limit: 1000, loss: 1500 },
};

/**
 * A deliberately small stand-in for the query builder: it records what the
 * caller filtered on so the tests can assert the FK actually got resolved the
 * way the module claims, rather than just that "some insert happened".
 */
interface Recorded {
  table: string;
  filters: Array<[string, unknown]>;
}

function buildDb(options: {
  accounts?: Record<string, unknown>[];
  violations?: Record<string, unknown>[];
  accountInsertFails?: boolean;
  violationInsertFails?: boolean;
}) {
  const selects: Recorded[] = [];
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const accounts = [...(options.accounts ?? [])];
  const violations = [...(options.violations ?? [])];

  function readColumn(row: Record<string, unknown>, column: string): unknown {
    const json = column.match(/^(\w+)->>(\w+)$/);
    if (json) {
      const container = row[json[1]] as Record<string, unknown> | undefined;
      return container?.[json[2]];
    }
    return row[column];
  }

  function selectBuilder(table: string, rows: Record<string, unknown>[]) {
    const record: Recorded = { table, filters: [] };
    selects.push(record);
    let limit = Infinity;

    const builder: Record<string, unknown> = {
      eq(column: string, value: unknown) {
        record.filters.push([column, value]);
        return builder;
      },
      limit(n: number) {
        limit = n;
        return builder;
      },
      order: () => builder,
      returns: () => builder,
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        const data = rows
          .filter((row) => record.filters.every(([c, v]) => readColumn(row, c) === v))
          .slice(0, limit);
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    db: {
      tenantId: TENANT,
      select: (table: string, _columns: string) =>
        selectBuilder(table, table === 'accounts' ? accounts : violations),
      insert(table: string, row: Record<string, unknown>) {
        const stamped = { ...row, tenant_id: TENANT };
        inserts.push({ table, row: stamped });

        const fails =
          (table === 'accounts' && options.accountInsertFails) ||
          (table === 'violations' && options.violationInsertFails);

        const created = { ...stamped, id: `${table}-inserted` };
        if (!fails) {
          if (table === 'accounts') accounts.push(created);
          else violations.push(created);
        }

        const builder: Record<string, unknown> = {
          select: () => builder,
          single: async () =>
            fails
              ? { data: null, error: { message: 'duplicate key value', code: '23505' } }
              : { data: created, error: null },
        };
        return builder;
      },
    },
    selects,
    inserts,
  };
}

function rulePackFinding(overrides: Record<string, unknown> = {}) {
  return {
    source: 'rule_pack' as const,
    ruleId: 'daily_loss' as const,
    action: 'terminate' as const,
    exceededBy: 500,
    evidence: EVIDENCE,
    idempotencyKey: 'key-abc',
    breachDecisionId: 'decision-1',
    rulePackId: 'pack-1',
    rulePackVersion: 3,
    rulePackContentHash: 'hash-1',
    ...overrides,
  };
}

describe('recordViolation — rule-pack findings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates the row with the full decision record in details_json', async () => {
    const { db, inserts } = buildDb({
      accounts: [
        { id: ACCOUNT_UUID, login: '1001', phase: 'funded', challenge_type: 'pro', account_size: 100000 },
      ],
    });

    const result = await recordViolation(db as never, {
      accountKey: ACCOUNT_UUID,
      finding: rulePackFinding(),
    });

    expect(result.created).toBe(true);
    expect(result.violationId).toBe('violations-inserted');
    expect(result.accountId).toBe(ACCOUNT_UUID);
    expect(result.idempotencyKey).toBe('key-abc');

    const row = inserts.find((i) => i.table === 'violations')!.row;
    expect(row.account_id).toBe(ACCOUNT_UUID);
    expect(row.violation_type).toBe('daily_loss');
    expect(row.severity).toBe('critical');
    // Phase/challenge/size come from the resolved account, not from the finding.
    expect(row.phase).toBe('funded');
    expect(row.challenge_type).toBe('pro');
    expect(row.account_size).toBe(100000);

    const details = row.details_json as Record<string, unknown>;
    expect(details.source).toBe('rule_pack');
    expect(details.idempotency_key).toBe('key-abc');
    expect(details.breach_decision_id).toBe('decision-1');
    expect(details.rule_pack_id).toBe('pack-1');
    expect(details.rule_pack_version).toBe(3);
    expect(details.rule_pack_content_hash).toBe('hash-1');
    expect(details.evidence).toEqual(EVIDENCE);
  });

  it('keeps only real uuids in related_trade_ids and every cited id in details', async () => {
    const { db, inserts } = buildDb({
      accounts: [
        { id: ACCOUNT_UUID, login: '1001', phase: 'funded', challenge_type: 'pro', account_size: 100000 },
      ],
    });

    await recordViolation(db as never, { accountKey: ACCOUNT_UUID, finding: rulePackFinding() });

    const row = inserts.find((i) => i.table === 'violations')!.row;
    // `related_trade_ids` is UUID[]; a non-uuid would abort the insert.
    expect(row.related_trade_ids).toEqual(['cccccccc-cccc-cccc-cccc-cccccccccccc']);
    expect((row.details_json as Record<string, unknown>).cited_trade_ids).toEqual(EVIDENCE.tradeIds);
  });

  it('is idempotent: an already-recorded decision writes nothing', async () => {
    const { db, inserts } = buildDb({
      accounts: [
        { id: ACCOUNT_UUID, login: '1001', phase: 'funded', challenge_type: 'pro', account_size: 100000 },
      ],
      violations: [
        { id: 'violation-existing', account_id: ACCOUNT_UUID, details_json: { idempotency_key: 'key-abc' } },
      ],
    });

    const result = await recordViolation(db as never, {
      accountKey: ACCOUNT_UUID,
      finding: rulePackFinding(),
    });

    expect(result).toEqual({
      violationId: 'violation-existing',
      created: false,
      accountId: ACCOUNT_UUID,
      accountCreated: false,
      idempotencyKey: 'key-abc',
    });
    expect(inserts).toHaveLength(0);
  });

  it('adopts the winner when a concurrent run wins the unique index', async () => {
    const { db } = buildDb({
      accounts: [
        { id: ACCOUNT_UUID, login: '1001', phase: 'funded', challenge_type: 'pro', account_size: 100000 },
      ],
      violationInsertFails: true,
    });

    // Nothing matches the key on the first read, the insert loses the race, and
    // the re-read then finds the row the winner wrote.
    const original = db.select;
    let readCount = 0;
    db.select = ((table: string, columns: string) => {
      if (table === 'violations') readCount++;
      if (table === 'violations' && readCount > 1) {
        return {
          eq: () => ({
            limit: () => ({
              returns: () => Promise.resolve({ data: [{ id: 'violation-winner', account_id: ACCOUNT_UUID }], error: null }),
            }),
          }),
        };
      }
      return original.call(db, table, columns);
    }) as typeof db.select;

    const result = await recordViolation(db as never, {
      accountKey: ACCOUNT_UUID,
      finding: rulePackFinding(),
    });

    expect(result.violationId).toBe('violation-winner');
    expect(result.created).toBe(false);
  });
});

describe('recordViolation — account FK resolution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves a platform account id through login', async () => {
    const { db, inserts } = buildDb({
      accounts: [
        { id: ACCOUNT_UUID, login: '1001', phase: 'challenge', challenge_type: 'flex', account_size: 50000 },
      ],
    });

    const result = await recordViolation(db as never, {
      accountKey: '1001',
      finding: { source: 'legacy_engine', violationType: 'hft', amount: 250, platformTradeIds: ['pt-1'] },
    });

    expect(result.accountId).toBe(ACCOUNT_UUID);
    expect(result.accountCreated).toBe(false);
    const row = inserts.find((i) => i.table === 'violations')!.row;
    expect(row.account_id).toBe(ACCOUNT_UUID);
    expect(row.phase).toBe('challenge');
    expect(row.challenge_type).toBe('flex');
  });

  it('finds a previously synthesised row by user_profile_id, so a re-run does not duplicate it', async () => {
    // This is the shape a synthesised row has: the PLATFORM account id lives in
    // user_profile_id, and the login is something else entirely. Probing only
    // id and login would miss it and try to insert again.
    const { db, inserts } = buildDb({
      accounts: [
        {
          id: ACCOUNT_UUID,
          login: '1001',
          user_profile_id: 'platform-acct-77',
          phase: 'funded',
          challenge_type: 'pro',
          account_size: 100000,
        },
      ],
    });

    const result = await recordViolation(db as never, {
      accountKey: 'platform-acct-77',
      accountFallback: { login: 'other-login', startingBalance: 100000 },
      finding: { source: 'legacy_engine', violationType: 'grid', amount: 40 },
    });

    expect(result.accountId).toBe(ACCOUNT_UUID);
    expect(result.accountCreated).toBe(false);
    expect(inserts.filter((i) => i.table === 'accounts')).toHaveLength(0);
  });

  it('synthesises the accounts row from platform details, snapping account_size to a legal tier', async () => {
    const { db, inserts } = buildDb({ accounts: [] });

    const result = await recordViolation(db as never, {
      accountKey: 'platform-acct-77',
      accountFallback: {
        login: '1001',
        email: 'trader@firm.test',
        traderName: 'A Trader',
        // Not one of the eight CHECK-constrained tiers.
        startingBalance: 97_500,
        userProfileId: 'platform-acct-77',
      },
      finding: { source: 'legacy_engine', violationType: 'martingale', amount: 900 },
    });

    expect(result.accountCreated).toBe(true);

    const account = inserts.find((i) => i.table === 'accounts')!.row;
    expect(account.login).toBe('1001');
    expect(account.user_profile_id).toBe('platform-acct-77');
    expect(account.account_size).toBe(100_000);
    expect(account.balance).toBe(97_500);

    const violation = inserts.find((i) => i.table === 'violations')!.row;
    expect(violation.severity).toBe('high');
    expect(violation.deduction_amount).toBe(900);
    const details = violation.details_json as Record<string, Record<string, unknown>>;
    // The approximation is recorded, not passed off as ingested truth.
    expect(details.account.synthesised).toBe(true);
    expect(details.account.platform_starting_balance).toBe(97_500);
    expect(details.account.account_size_snapped_to_tier).toBe(true);
  });

  it('records nothing, and says why, when no account can be resolved or created', async () => {
    const { db, inserts } = buildDb({ accounts: [] });

    const result = await recordViolation(db as never, {
      accountKey: 'platform-acct-77',
      finding: { source: 'legacy_engine', violationType: 'news', amount: 10 },
    });

    expect(result.violationId).toBeNull();
    expect(result.reason).toMatch(/no accounts row/);
    expect(inserts).toHaveLength(0);
  });
});

describe('legacyFindingKey', () => {
  it('is stable across runs and independent of trade ordering', () => {
    const a = legacyFindingKey('acct-1', 'hft', ['t2', 't1'], 250);
    const b = legacyFindingKey('acct-1', 'hft', ['t1', 't2'], 250.004);
    expect(a).toBe(b);
    expect(a.startsWith('legacy:')).toBe(true);
  });

  it('changes when a new trade joins the finding', () => {
    const before = legacyFindingKey('acct-1', 'hft', ['t1'], 250);
    const after = legacyFindingKey('acct-1', 'hft', ['t1', 't2'], 250);
    expect(before).not.toBe(after);
  });
});
