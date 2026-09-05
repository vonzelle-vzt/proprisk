import { describe, expect, it } from 'vitest';
import { diffRulePacks } from './diff';
import { presetById } from './presets';
import type { RulePack } from './schema';

const ftmo = presetById('ftmo-style')!.pack;
const topstep = presetById('topstep-style')!.pack;

describe('diffRulePacks', () => {
  it('reports identical for a pack compared to itself', () => {
    const diff = diffRulePacks(ftmo, ftmo);
    expect(diff.identical).toBe(true);
    expect(diff.changes).toHaveLength(0);
  });

  it('reports a threshold change in plain language, as a percentage not a fraction', () => {
    const before = ftmo;
    const after: RulePack = {
      ...before,
      rules: {
        ...before.rules,
        drawdown: { ...before.rules.drawdown!, threshold: { type: 'pct_of_initial', value: 0.08 } },
      },
    };

    const diff = diffRulePacks(before, after);
    expect(diff.identical).toBe(false);
    const change = diff.changes.find((c) => c.ruleId === 'drawdown');
    expect(change).toBeDefined();
    expect(change!.kind).toBe('changed');
    expect(change!.summary).toContain('10%');
    expect(change!.summary).toContain('8%');
    // The 100x fraction/percent bug this exists to prevent: never emit 0.08 raw.
    expect(change!.summary).not.toContain('0.08');
  });

  it('reports a rule being turned off as "removed", not a lax threshold', () => {
    const before = ftmo;
    const after: RulePack = {
      ...before,
      rules: { ...before.rules, daily_loss: { ...before.rules.daily_loss!, enabled: false } },
    };

    const diff = diffRulePacks(before, after);
    const change = diff.changes.find((c) => c.ruleId === 'daily_loss');
    expect(change).toBeDefined();
    expect(change!.kind).toBe('removed');
    expect(change!.summary).toBe('daily loss limit removed');
  });

  it('reports an absent rule becoming enabled as "added"', () => {
    const before = ftmo; // no consistency rule
    const after: RulePack = {
      ...before,
      rules: {
        ...before.rules,
        consistency: {
          enabled: true,
          max_best_day_pct_of_profit: 0.4,
          evaluated_at: 'payout',
          min_profit_to_evaluate: 0,
          applies_to_phases: ['challenge', 'verification', 'funded'],
          action: 'flag_for_review',
        },
      },
    };

    const diff = diffRulePacks(before, after);
    const change = diff.changes.find((c) => c.ruleId === 'consistency');
    expect(change).toBeDefined();
    expect(change!.kind).toBe('added');
  });

  it('describes a drawdown lock change moving to "locks at the initial balance"', () => {
    const before: RulePack = {
      ...ftmo,
      rules: { ...ftmo.rules, drawdown: { ...ftmo.rules.drawdown!, lock: 'never' } },
    };
    const after: RulePack = {
      ...before,
      rules: { ...before.rules, drawdown: { ...before.rules.drawdown!, lock: 'at_initial_balance' } },
    };

    const diff = diffRulePacks(before, after);
    const change = diff.changes.find((c) => c.ruleId === 'drawdown');
    expect(change!.summary).toContain('locks at the starting balance');
  });

  it('reports an action change independent of the threshold', () => {
    const before = ftmo;
    const after: RulePack = {
      ...before,
      rules: { ...before.rules, daily_loss: { ...before.rules.daily_loss!, action: 'pause_trading' } },
    };

    const diff = diffRulePacks(before, after);
    const change = diff.changes.find((c) => c.ruleId === 'daily_loss');
    expect(change!.summary).toContain('terminate -> pause_trading');
  });

  it('distinguishes two genuinely different preset shapes with multiple changes', () => {
    const diff = diffRulePacks(ftmo, topstep as unknown as RulePack);
    expect(diff.identical).toBe(false);
    expect(diff.changes.length).toBeGreaterThan(0);
  });

  it('never throws on packs with no shared enabled rules', () => {
    const empty: RulePack = { ...ftmo, rules: {} };
    expect(() => diffRulePacks(empty, ftmo)).not.toThrow();
    expect(() => diffRulePacks(ftmo, empty)).not.toThrow();
  });
});
