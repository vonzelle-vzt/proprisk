import { describe, expect, it } from 'vitest';
import { evaluateRulePack } from './evaluate';
import { RULE_PACK_PRESETS, presetById } from './presets';
import { parseRulePack, rulePackSchema, validateRulePack, type RulePack } from './schema';
import { sessionDayKey } from './session';
import type { AccountContext, EvaluationInput, EquitySnapshot, TradeInput } from './types';

/**
 * Golden vectors.
 *
 * A fixed trade tape against a fixed pack must produce an exact breach set. If
 * one of these moves, either the rule semantics changed on purpose — in which
 * case the expectation is edited deliberately, in the same commit, with the
 * reason — or a regression has been introduced. These are the closest thing the
 * product has to a proof of correctness, because a wrong breach decision is
 * somebody's account and somebody's money.
 */

const PACK_VERSION = 'v1-test';

function account(overrides: Partial<AccountContext> = {}): AccountContext {
  return {
    id: 'acc-1',
    login: '1001',
    phase: 'funded',
    startingBalance: 100_000,
    currentBalance: 100_000,
    currentEquity: 100_000,
    ...overrides,
  };
}

function trade(id: string, at: string, profit: number, size = 1): TradeInput {
  return { id, symbol: 'ES', openTime: at, closeTime: at, profit, size, isOpen: false };
}

function snap(at: string, equity: number): EquitySnapshot {
  return { at, balance: equity, equity };
}

function input(over: Partial<EvaluationInput> & { account?: AccountContext }): EvaluationInput {
  return {
    account: over.account ?? account(),
    trades: over.trades ?? [],
    snapshots: over.snapshots,
    newsEvents: over.newsEvents,
    now: over.now ?? '2026-03-10T22:00:00Z',
  };
}

describe('every shipped preset is a valid, coherent pack', () => {
  it.each(RULE_PACK_PRESETS.map((p) => [p.id, p] as const))('%s parses and validates', (_id, preset) => {
    expect(() => rulePackSchema.parse(preset.pack)).not.toThrow();
    const { valid, errors } = validateRulePack(preset.pack);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it('covers both asset classes', () => {
    const classes = new Set(RULE_PACK_PRESETS.map((p) => p.assetClass));
    expect(classes).toEqual(new Set(['forex', 'futures']));
  });
});

describe('the three drawdown models disagree on the SAME trade tape', () => {
  // The account runs up to +$3,000 intraday on day 1, closes day 1 at +$500,
  // then falls away. Each model draws its floor somewhere different, which is
  // the entire reason drawdown is one parameterised primitive and not three.
  const snapshots: EquitySnapshot[] = [
    snap('2026-03-02T15:00:00Z', 100_000),
    snap('2026-03-02T17:00:00Z', 103_000), // intraday peak, never banked
    snap('2026-03-02T20:55:00Z', 100_500), // day 1 close
    snap('2026-03-03T18:00:00Z', 97_200), // day 2 slide
  ];

  function packWith(mode: 'static' | 'trailing_intraday' | 'trailing_eod', lock: 'never' | 'at_initial_balance'): RulePack {
    return {
      schema_version: 1,
      asset_class: 'futures',
      name: `${mode} test`,
      session: { timezone: 'America/New_York', day_start: '17:00', week_start: 'sunday' },
      rules: {
        drawdown: {
          enabled: true,
          mode,
          lock,
          basis: 'equity',
          threshold: { type: 'fixed', value: 3_000 },
          applies_to_phases: ['challenge', 'verification', 'funded'],
          action: 'terminate',
        },
      },
    };
  }

  it('static: floor stays at 97,000 and the 97,200 low does NOT breach', () => {
    const result = evaluateRulePack(packWith('static', 'never'), input({ snapshots }), PACK_VERSION);
    expect(result.decisions).toEqual([]);
  });

  it('trailing_intraday: the unbanked 103,000 peak raises the floor to 100,000, so 97,200 DOES breach', () => {
    const result = evaluateRulePack(
      packWith('trailing_intraday', 'never'),
      input({ snapshots }),
      PACK_VERSION
    );
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].ruleId).toBe('drawdown');
    expect(result.decisions[0].action).toBe('terminate');
    expect(result.decisions[0].evidence.values.floor).toBe(100_000);
    expect(result.decisions[0].exceededBy).toBeCloseTo(2_800, 2);
  });

  it('trailing_eod: only the 100,500 CLOSE counts, so the floor is 97,500 and 97,200 breaches by less', () => {
    const result = evaluateRulePack(
      packWith('trailing_eod', 'never'),
      input({ snapshots }),
      PACK_VERSION
    );
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].evidence.values.floor).toBe(97_500);
    expect(result.decisions[0].exceededBy).toBeCloseTo(300, 2);
  });

  // The lock is what makes a funded account progressively safer. Without it a
  // profitable trader is never further from breach than a brand new one.
  it('lock at_initial_balance stops the floor rising above the starting balance', () => {
    const climbing: EquitySnapshot[] = [
      snap('2026-03-02T15:00:00Z', 100_000),
      snap('2026-03-02T20:55:00Z', 110_000), // +10k; unlocked floor would be 107,000
      snap('2026-03-03T18:00:00Z', 101_000),
    ];

    const locked = evaluateRulePack(
      packWith('trailing_eod', 'at_initial_balance'),
      input({ snapshots: climbing }),
      PACK_VERSION
    );
    expect(locked.decisions).toEqual([]);

    const unlocked = evaluateRulePack(
      packWith('trailing_eod', 'never'),
      input({ snapshots: climbing }),
      PACK_VERSION
    );
    expect(unlocked.decisions).toHaveLength(1);
    expect(unlocked.decisions[0].evidence.values.floor).toBe(107_000);
  });

  // Silently applying the end-of-day model when snapshots are missing would
  // answer a laxer question than the firm configured.
  it('reports indeterminate rather than guessing when intraday data is absent', () => {
    const result = evaluateRulePack(
      packWith('trailing_intraday', 'never'),
      input({ trades: [trade('t1', '2026-03-02T15:00:00Z', -5_000)] }),
      PACK_VERSION
    );
    expect(result.decisions).toEqual([]);
    expect(result.skipped.find((s) => s.ruleId === 'drawdown')?.reason).toMatch(/snapshots/i);
  });
});

describe('daily loss: the basis is the whole difference between firms', () => {
  function packWith(basis: 'balance' | 'equity' | 'highest_equity_of_day'): RulePack {
    return {
      schema_version: 1,
      asset_class: 'futures',
      name: `${basis} test`,
      session: { timezone: 'America/New_York', day_start: '17:00', week_start: 'sunday' },
      rules: {
        daily_loss: {
          enabled: true,
          basis,
          include_open_pnl: true,
          threshold: { type: 'fixed', value: 2_000 },
          applies_to_phases: ['challenge', 'verification', 'funded'],
          action: 'terminate',
        },
      },
    };
  }

  // Up $2,500, then down to −$100 on the day. Realised loss is $100; measured
  // from the intraday high-water mark it is $2,600.
  const trades = [
    trade('t1', '2026-03-02T15:00:00Z', 2_500),
    trade('t2', '2026-03-02T19:00:00Z', -2_600),
  ];
  const snapshots = [
    snap('2026-03-02T14:00:00Z', 100_000),
    snap('2026-03-02T15:30:00Z', 102_500),
    snap('2026-03-02T19:30:00Z', 99_900),
  ];

  it('balance basis: a $100 net loss does not breach a $2,000 limit', () => {
    const result = evaluateRulePack(packWith('balance'), input({ trades, snapshots }), PACK_VERSION);
    expect(result.decisions).toEqual([]);
  });

  it('highest_equity_of_day: the same day breaches, because the peak is the reference', () => {
    const result = evaluateRulePack(
      packWith('highest_equity_of_day'),
      input({ trades, snapshots }),
      PACK_VERSION
    );
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].evidence.values.loss).toBeCloseTo(2_600, 2);
    expect(result.decisions[0].exceededBy).toBeCloseTo(600, 2);
  });

  it('highest_equity_of_day without snapshots is indeterminate, never a silent pass', () => {
    const result = evaluateRulePack(
      packWith('highest_equity_of_day'),
      input({ trades }),
      PACK_VERSION
    );
    expect(result.decisions).toEqual([]);
    expect(result.skipped.find((s) => s.ruleId === 'daily_loss')).toBeDefined();
  });
});

describe('session-day bucketing (the bug the old UTC slice caused)', () => {
  const session = { timezone: 'America/New_York', day_start: '17:00', week_start: 'sunday' as const };

  it('puts a Sunday 18:00 ET trade into MONDAY’s session', () => {
    // 2026-03-01 is a Sunday. 18:00 ET = 23:00 UTC same day.
    expect(sessionDayKey('2026-03-01T23:00:00Z', session)).toBe('2026-03-02');
  });

  it('puts a Monday 10:00 ET trade into Monday’s session', () => {
    expect(sessionDayKey('2026-03-02T15:00:00Z', session)).toBe('2026-03-02');
  });

  it('rolls a Monday 17:30 ET trade into TUESDAY’s session', () => {
    expect(sessionDayKey('2026-03-02T22:30:00Z', session)).toBe('2026-03-03');
  });

  it('treats day_start 00:00 as plain calendar days, with no shift', () => {
    const fx = { timezone: 'Europe/Prague', day_start: '00:00', week_start: 'sunday' as const };
    expect(sessionDayKey('2026-03-02T10:00:00Z', fx)).toBe('2026-03-02');
    expect(sessionDayKey('2026-03-02T23:00:00Z', fx)).toBe('2026-03-03'); // already next day in Prague
  });

  it('splits one session’s losses correctly across the 17:00 boundary', () => {
    const pack: RulePack = {
      schema_version: 1,
      asset_class: 'futures',
      name: 'session test',
      session,
      rules: {
        daily_loss: {
          enabled: true,
          basis: 'balance',
          include_open_pnl: false,
          threshold: { type: 'fixed', value: 1_500 },
          applies_to_phases: ['funded'],
          action: 'terminate',
        },
      },
    };

    // −$900 at Sunday 18:00 ET and −$900 at Monday 10:00 ET are the SAME
    // session and together breach $1,500. Bucketed by UTC date they would be
    // two separate $900 days and neither would breach.
    const result = evaluateRulePack(
      pack,
      input({
        trades: [
          trade('t1', '2026-03-01T23:00:00Z', -900),
          trade('t2', '2026-03-02T15:00:00Z', -900),
        ],
      }),
      PACK_VERSION
    );

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].evidence.sessionDay).toBe('2026-03-02');
    expect(result.decisions[0].evidence.values.loss).toBeCloseTo(1_800, 2);
  });
});

describe('a disabled rule does not exist (the Lucid case)', () => {
  it('produces no daily-loss decision when the firm has no such rule', () => {
    const lucid = presetById('lucid-style')!;
    expect(lucid.pack.rules.daily_loss).toBeUndefined();
    expect(lucid.pack.rules.consistency).toBeUndefined();

    const result = evaluateRulePack(
      lucid.pack,
      input({
        account: account({ startingBalance: 50_000, phase: 'funded' }),
        trades: [trade('t1', '2026-03-02T15:00:00Z', -20_000)],
      }),
      PACK_VERSION
    );

    expect(result.decisions.some((d) => d.ruleId === 'daily_loss')).toBe(false);
    expect(result.decisions.some((d) => d.ruleId === 'consistency')).toBe(false);
  });

  it('enabled:false is honoured exactly like omission', () => {
    const pack: RulePack = {
      schema_version: 1,
      asset_class: 'futures',
      name: 'disabled test',
      session: { timezone: 'America/New_York', day_start: '17:00', week_start: 'sunday' },
      rules: {
        daily_loss: {
          enabled: false,
          basis: 'balance',
          include_open_pnl: true,
          threshold: { type: 'fixed', value: 1 },
          applies_to_phases: ['funded'],
          action: 'terminate',
        },
        drawdown: {
          enabled: true,
          mode: 'static',
          lock: 'never',
          basis: 'balance',
          threshold: { type: 'fixed', value: 5_000 },
          applies_to_phases: ['funded'],
          action: 'terminate',
        },
      },
    };

    const result = evaluateRulePack(
      pack,
      input({ trades: [trade('t1', '2026-03-02T15:00:00Z', -100)] }),
      PACK_VERSION
    );
    expect(result.decisions).toEqual([]);
  });
});

describe('phase scoping (the Tradeify case)', () => {
  it('applies the consistency rule in evaluation and NOT once funded', () => {
    const tradeify = presetById('tradeify-style')!;
    // One outsized day: 90% of all profit, well over the 40% cap.
    const trades = [
      trade('t1', '2026-03-02T15:00:00Z', 9_000),
      trade('t2', '2026-03-03T15:00:00Z', 1_000),
    ];

    const inChallenge = evaluateRulePack(
      tradeify.pack,
      input({ account: account({ phase: 'challenge' }), trades }),
      PACK_VERSION
    );
    expect(inChallenge.decisions.some((d) => d.ruleId === 'consistency')).toBe(true);

    const whenFunded = evaluateRulePack(
      tradeify.pack,
      input({ account: account({ phase: 'funded' }), trades }),
      PACK_VERSION
    );
    expect(whenFunded.decisions.some((d) => d.ruleId === 'consistency')).toBe(false);
  });
});

describe('action is independent of the rule (the The5ers case)', () => {
  it('terminates on daily loss where TopStep only pauses trading', () => {
    const the5ers = presetById('the5ers-style')!;
    const topstep = presetById('topstep-style')!;

    expect(the5ers.pack.rules.daily_loss?.action).toBe('terminate');
    expect(topstep.pack.rules.daily_loss?.action).toBe('pause_trading');

    const trades = [trade('t1', '2026-03-02T15:00:00Z', -6_000)];
    const a = evaluateRulePack(
      the5ers.pack,
      input({ account: account({ phase: 'funded' }), trades }),
      PACK_VERSION
    );
    expect(a.decisions.find((d) => d.ruleId === 'daily_loss')?.action).toBe('terminate');
  });
});

describe('idempotency keys replace wall-clock dedup', () => {
  const pack = presetById('ftmo-style')!.pack;
  const trades = [trade('t1', '2026-03-02T10:00:00Z', -6_000)];

  it('is stable across repeated evaluation of identical inputs', () => {
    const a = evaluateRulePack(pack, input({ trades }), PACK_VERSION);
    const b = evaluateRulePack(pack, input({ trades }), PACK_VERSION);
    expect(a.decisions.map((d) => d.idempotencyKey)).toEqual(b.decisions.map((d) => d.idempotencyKey));
    expect(a.decisions.length).toBeGreaterThan(0);
  });

  it('changes when the pack version changes, so a re-run under new rules is a new decision', () => {
    const a = evaluateRulePack(pack, input({ trades }), 'v1');
    const b = evaluateRulePack(pack, input({ trades }), 'v2');
    expect(a.decisions[0].idempotencyKey).not.toBe(b.decisions[0].idempotencyKey);
  });

  it('changes when the measured numbers change', () => {
    const a = evaluateRulePack(pack, input({ trades }), PACK_VERSION);
    const b = evaluateRulePack(
      pack,
      input({ trades: [trade('t1', '2026-03-02T10:00:00Z', -7_000)] }),
      PACK_VERSION
    );
    expect(a.decisions[0].idempotencyKey).not.toBe(b.decisions[0].idempotencyKey);
  });
});

describe('semantic validation catches misconfigurations a schema cannot', () => {
  const base = presetById('ftmo-style')!.pack;

  it('rejects a static drawdown that also declares a lock', () => {
    const bad = structuredClone(base);
    bad.rules.drawdown!.lock = 'at_initial_balance';
    expect(validateRulePack(bad).errors.join(' ')).toMatch(/static floor does not trail/i);
  });

  it('rejects a daily loss larger than the drawdown, which would be unreachable', () => {
    const bad = structuredClone(base);
    bad.rules.daily_loss!.threshold = { type: 'pct_of_initial', value: 0.2 };
    expect(validateRulePack(bad).errors.join(' ')).toMatch(/unreachable/i);
  });

  it('rejects a pack with every rule disabled', () => {
    const bad = structuredClone(base);
    bad.rules.drawdown!.enabled = false;
    bad.rules.daily_loss!.enabled = false;
    expect(validateRulePack(bad).errors.join(' ')).toMatch(/at least one rule/i);
  });

  it('rejects a continuous consistency rule with no profit floor', () => {
    const bad = structuredClone(base);
    bad.rules.consistency = {
      enabled: true,
      max_best_day_pct_of_profit: 0.4,
      evaluated_at: 'continuous',
      min_profit_to_evaluate: 0,
      applies_to_phases: ['funded'],
      action: 'warn',
    };
    expect(validateRulePack(bad).errors.join(' ')).toMatch(/first profitable day/i);
  });

  // Percentages are fractions here. Accepting 5 for "5%" would be a 100x error
  // on every threshold in the pack.
  it('rejects a percentage expressed as 5 instead of 0.05', () => {
    expect(() =>
      parseRulePack({
        ...base,
        rules: {
          drawdown: {
            ...base.rules.drawdown,
            threshold: { type: 'pct_of_initial', value: 5 },
          },
        },
      })
    ).toThrow();
  });

  it('rejects an invalid IANA timezone', () => {
    expect(() => parseRulePack({ ...base, session: { ...base.session, timezone: 'Mars/Olympus' } })).toThrow();
  });
});

describe('position limits refuse to invent a default', () => {
  it('reports a configuration gap for an unlisted account size', () => {
    const pack = presetById('apex-style')!.pack;
    const result = evaluateRulePack(
      pack,
      input({
        account: account({ startingBalance: 75_000 }), // deliberately unlisted
        trades: [trade('t1', '2026-03-02T15:00:00Z', 100, 40)],
      }),
      PACK_VERSION
    );

    expect(result.decisions.some((d) => d.ruleId === 'position_limit')).toBe(false);
    expect(result.skipped.find((s) => s.ruleId === 'position_limit')?.reason).toMatch(
      /limits_by_size/
    );
  });

  it('breaches when a listed size is exceeded', () => {
    const pack = presetById('apex-style')!.pack;
    const result = evaluateRulePack(
      pack,
      input({
        account: account({ startingBalance: 50_000 }), // limit 10
        trades: [trade('t1', '2026-03-02T15:00:00Z', 100, 14)],
      }),
      PACK_VERSION
    );

    const decision = result.decisions.find((d) => d.ruleId === 'position_limit');
    expect(decision).toBeDefined();
    expect(decision!.exceededBy).toBe(4);
  });
});

describe('cross-account rules are declared, not silently ignored', () => {
  it('reports grid/copy as evaluated elsewhere rather than passing', () => {
    const pack: RulePack = {
      ...presetById('ftmo-style')!.pack,
      rules: {
        ...presetById('ftmo-style')!.pack.rules,
        copy_trading: {
          enabled: true,
          lag_window_seconds: 60,
          lot_size_tolerance: 0.1,
          min_copied_trades: 5,
          score_threshold: 0.7,
          applies_to_phases: ['funded'],
          action: 'flag_for_review',
        },
      },
    };

    const result = evaluateRulePack(pack, input({ account: account({ phase: 'funded' }) }), PACK_VERSION);
    expect(result.skipped.find((s) => s.ruleId === 'copy_trading')?.reason).toMatch(
      /per-tenant network pass/
    );
  });
});

describe('evidence is self-contained enough to defend a decision', () => {
  it('carries the limit, the observation, the arithmetic and the trades', () => {
    const result = evaluateRulePack(
      presetById('ftmo-style')!.pack,
      input({ trades: [trade('t1', '2026-03-02T10:00:00Z', -6_000)] }),
      PACK_VERSION
    );

    const d = result.decisions.find((x) => x.ruleId === 'daily_loss')!;
    expect(d.evidence.limit).toMatch(/5\.00% of the \$100000\.00 starting balance/);
    expect(d.evidence.observed).toMatch(/\$6000\.00 lost/);
    expect(d.evidence.math).toMatch(/against a \$5000\.00 limit/);
    expect(d.evidence.tradeIds).toEqual(['t1']);
    expect(d.evidence.values.exceededBy).toBeCloseTo(1_000, 2);
  });
});
