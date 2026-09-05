import { describe, expect, it } from 'vitest';
import { previewImpact, type AccountImpactInput } from './impact';
import type { RulePack } from './schema';
import type { EvaluationInput } from './types';

const SESSION = { timezone: 'America/New_York', day_start: '00:00', week_start: 'sunday' as const };

function packWithDrawdown(thresholdFraction: number): RulePack {
  return {
    schema_version: 1,
    asset_class: 'forex',
    name: 'test pack',
    session: SESSION,
    rules: {
      drawdown: {
        enabled: true,
        mode: 'static',
        lock: 'never',
        basis: 'balance',
        threshold: { type: 'pct_of_initial', value: thresholdFraction },
        applies_to_phases: ['challenge', 'verification', 'funded'],
        action: 'terminate',
      },
    },
  };
}

/** One account that has already lost 6% of its $100k starting balance. */
function accountDown6Pct(id: string): AccountImpactInput {
  const input: EvaluationInput = {
    account: {
      id,
      login: `acct-${id}`,
      phase: 'funded',
      startingBalance: 100000,
      currentBalance: 94000,
      currentEquity: 94000,
    },
    trades: [
      {
        id: 't1',
        symbol: 'EURUSD',
        openTime: '2026-01-01T10:00:00Z',
        closeTime: '2026-01-01T12:00:00Z',
        profit: -6000,
        size: 1,
        isOpen: false,
      },
    ],
    now: '2026-01-02T00:00:00Z',
  };
  return { accountId: id, login: input.account.login, input };
}

/** An account flat at its starting balance — never breaches anything. */
function accountFlat(id: string): AccountImpactInput {
  const input: EvaluationInput = {
    account: {
      id,
      login: `acct-${id}`,
      phase: 'funded',
      startingBalance: 100000,
      currentBalance: 100000,
      currentEquity: 100000,
    },
    trades: [],
    now: '2026-01-02T00:00:00Z',
  };
  return { accountId: id, login: input.account.login, input };
}

describe('previewImpact', () => {
  it('reports no change when the candidate pack is identical to the current one', () => {
    const pack = packWithDrawdown(0.1);
    const report = previewImpact(pack, pack, [accountDown6Pct('a1'), accountFlat('a2')]);
    expect(report.changed).toHaveLength(0);
    expect(report.unchangedCount).toBe(2);
  });

  it('flags an account that would newly breach when the threshold tightens', () => {
    const current = packWithDrawdown(0.1); // 10% floor: a 6% drawdown does not breach
    const candidate = packWithDrawdown(0.04); // 4% floor: the same 6% drawdown now breaches

    const report = previewImpact(current, candidate, [accountDown6Pct('a1'), accountFlat('a2')]);

    expect(report.changed).toHaveLength(1);
    expect(report.changed[0].accountId).toBe('a1');
    expect(report.changed[0].newBreaches).toHaveLength(1);
    expect(report.changed[0].newBreaches[0].ruleId).toBe('drawdown');
    expect(report.changed[0].newBreaches[0].action).toBe('terminate');
    expect(report.unchangedCount).toBe(1);
    expect(report.newTerminations).toBe(1);
  });

  it('flags an account that would be cleared when the threshold loosens', () => {
    const current = packWithDrawdown(0.04); // breaches at 6% drawdown
    const candidate = packWithDrawdown(0.1); // does not

    const report = previewImpact(current, candidate, [accountDown6Pct('a1')]);

    expect(report.changed).toHaveLength(1);
    expect(report.changed[0].clearedBreaches).toHaveLength(1);
    expect(report.changed[0].newBreaches).toHaveLength(0);
    expect(report.newTerminations).toBe(0);
  });

  it('reports an action change when the same breach now carries a different consequence', () => {
    const current = packWithDrawdown(0.04);
    const candidate: RulePack = {
      ...current,
      rules: { drawdown: { ...current.rules.drawdown!, action: 'flag_for_review' } },
    };

    const report = previewImpact(current, candidate, [accountDown6Pct('a1')]);

    expect(report.changed).toHaveLength(1);
    expect(report.changed[0].actionChanges).toEqual([
      { ruleId: 'drawdown', from: 'terminate', to: 'flag_for_review' },
    ]);
  });

  it('treats no current pack as every candidate breach being new', () => {
    const candidate = packWithDrawdown(0.04);
    const report = previewImpact(null, candidate, [accountDown6Pct('a1')]);

    expect(report.changed).toHaveLength(1);
    expect(report.changed[0].newBreaches).toHaveLength(1);
    expect(report.changed[0].clearedBreaches).toHaveLength(0);
  });

  it('summarises the worst case (new terminations) up front', () => {
    const current = packWithDrawdown(0.1);
    const candidate = packWithDrawdown(0.04);
    const report = previewImpact(current, candidate, [accountDown6Pct('a1')]);
    expect(report.summary).toContain('TERMINATED');
  });

  it('never throws on an empty account list', () => {
    const pack = packWithDrawdown(0.1);
    expect(() => previewImpact(pack, pack, [])).not.toThrow();
    const report = previewImpact(pack, pack, []);
    expect(report.summary).toContain('0');
  });
});
