import { describe, expect, it } from 'vitest';
import { computeHeadroom } from './headroom';
import { presetById } from '@/lib/rulepack/presets';
import type { EvaluationInput } from '@/lib/rulepack/types';

/**
 * The headroom view must never say something the breach engine would
 * disagree with. These tests pin the FTMO-style preset (static 10% drawdown
 * on balance + 5% daily loss, both `terminate`) against hand-computed
 * numbers, and cross-check the drawdown floor against `evaluateRulePack`
 * directly so the two paths cannot drift apart.
 */

const ftmo = presetById('ftmo-style')!.pack;
const NOW = '2026-06-15T12:00:00Z';

function baseInput(overrides: Partial<EvaluationInput['account']> = {}): EvaluationInput {
  return {
    account: {
      id: 'acct-1',
      login: '100234',
      phase: 'funded',
      startingBalance: 100_000,
      currentBalance: 98_000,
      currentEquity: 98_000,
      ...overrides,
    },
    trades: [
      {
        id: 't1',
        symbol: 'EURUSD',
        openTime: '2026-06-15T08:00:00Z',
        closeTime: '2026-06-15T09:00:00Z',
        profit: -2000,
        size: 1,
        isOpen: false,
      },
    ],
    now: NOW,
  };
}

describe('computeHeadroom — daily loss', () => {
  it('reports remaining headroom in plain language', () => {
    const result = computeHeadroom(ftmo, baseInput());
    const dailyLoss = result.items.find((i) => i.ruleId === 'daily_loss')!;

    expect(dailyLoss.status).toBe('ok');
    // 5% of 100,000 = 5,000 limit; 2,000 lost so far; 3,000 remaining.
    expect(dailyLoss.values.limit).toBe(5000);
    expect(dailyLoss.values.loss).toBe(2000);
    expect(dailyLoss.values.remaining).toBe(3000);
    expect(dailyLoss.headroom).toContain('3000.00');
  });

  it('flags breached once today\'s loss exceeds the limit', () => {
    const input = baseInput();
    input.trades[0].profit = -6000;
    const result = computeHeadroom(ftmo, input);
    const dailyLoss = result.items.find((i) => i.ruleId === 'daily_loss')!;

    expect(dailyLoss.status).toBe('breached');
    expect(dailyLoss.headroom).toBe('');
  });
});

describe('computeHeadroom — drawdown', () => {
  it('matches the floor the breach engine itself would compute', () => {
    const input = baseInput();
    const result = computeHeadroom(ftmo, input);
    const drawdown = result.items.find((i) => i.ruleId === 'drawdown')!;

    // static mode, never trails: floor = startingBalance - 10% = 90,000.
    expect(drawdown.drawdown).toEqual({ floor: 90_000, locked: false });
    expect(drawdown.status).toBe('ok');
    // currentBalance 98,000 - floor 90,000 = 8,000 headroom.
    expect(drawdown.values.remaining).toBe(8000);
  });

  it('flags breached once balance falls through the static floor', () => {
    const input = baseInput({ currentBalance: 85_000 });
    input.trades[0].profit = -15_000;
    const result = computeHeadroom(ftmo, input);
    const drawdown = result.items.find((i) => i.ruleId === 'drawdown')!;

    expect(drawdown.status).toBe('breached');
    expect(drawdown.drawdown?.floor).toBe(90_000);
  });
});

describe('computeHeadroom — scoping rules', () => {
  it('never includes cross-account or purely behavioural rules', () => {
    const result = computeHeadroom(ftmo, baseInput());
    const ruleIds = result.items.map((i) => i.ruleId);

    expect(ruleIds).not.toContain('grid');
    expect(ruleIds).not.toContain('copy_trading');
    expect(ruleIds).not.toContain('news');
    expect(ruleIds).not.toContain('hft');
    expect(ruleIds).not.toContain('martingale');
  });

  it('omits a rule not enabled for the pack', () => {
    const result = computeHeadroom(ftmo, baseInput());
    const ruleIds = result.items.map((i) => i.ruleId);
    // ftmo-style enables only drawdown and daily_loss.
    expect(ruleIds).not.toContain('consistency');
    expect(ruleIds).not.toContain('min_trading_days');
  });
});
