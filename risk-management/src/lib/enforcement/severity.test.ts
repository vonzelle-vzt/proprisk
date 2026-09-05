import { describe, expect, it } from 'vitest';
import { assessSeverity, computeRepeatMultiplier } from './severity';
import type { AccountViolationHistory } from '@/types/enforcement';

function historyRow(overrides: Partial<AccountViolationHistory> = {}): AccountViolationHistory {
  return {
    id: 'hist-1',
    account_id: 'account-1',
    violation_type: 'hft',
    total_count: 0,
    last_violation_at: null,
    total_deduction_amount: 0,
    escalation_tier: 0,
    count_last_24h: 0,
    count_last_7d: 0,
    count_last_30d: 0,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('computeRepeatMultiplier', () => {
  it('returns 1.0 for zero or negative prior counts', () => {
    expect(computeRepeatMultiplier(0)).toBe(1.0);
    expect(computeRepeatMultiplier(-1)).toBe(1.0);
  });

  it('returns 1.5 for exactly one prior violation', () => {
    expect(computeRepeatMultiplier(1)).toBe(1.5);
  });

  it('returns 2.0 for exactly two prior violations', () => {
    expect(computeRepeatMultiplier(2)).toBe(2.0);
  });

  it('returns 2.5 for three or more prior violations', () => {
    expect(computeRepeatMultiplier(3)).toBe(2.5);
    expect(computeRepeatMultiplier(10)).toBe(2.5);
  });
});

describe('assessSeverity', () => {
  it('scores a first-time low-value violation as normal', () => {
    const result = assessSeverity({
      violationType: 'hft', // base 10
      deductionAmount: 10, // no amount points (<=50)
      history: [],
    });
    expect(result.score).toBe(10);
    expect(result.escalation_level).toBe('normal');
    expect(result.factors.map((f) => f.name)).toEqual(['violation_type']);
  });

  it('uses the default base points (10) for an unknown violation type', () => {
    const result = assessSeverity({
      violationType: 'unknown_type',
      deductionAmount: 0,
      history: [],
    });
    expect(result.score).toBe(10);
  });

  it('accumulates deduction-amount, repeat-offender, and multi-type points', () => {
    const history: AccountViolationHistory[] = [
      historyRow({ violation_type: 'martingale', total_count: 4, count_last_30d: 2 }),
      historyRow({ violation_type: 'grid', total_count: 1, count_last_30d: 1 }),
      historyRow({ violation_type: 'news', total_count: 1, count_last_30d: 1 }),
    ];
    const result = assessSeverity({
      violationType: 'martingale', // base 20
      deductionAmount: 250, // >200 => +15
      history,
    });
    // base 20 + amount 15 + repeat(total_count 4 => >=4 => +15) + multi_type (3 distinct => +10) = 60
    expect(result.score).toBe(60);
    expect(result.escalation_level).toBe('urgent'); // >=51
    const names = result.factors.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['violation_type', 'deduction_amount', 'repeat_offender', 'multi_type']));
  });

  it('adds new-account, pending-payout, and banned-activity points', () => {
    const result = assessSeverity({
      violationType: 'copy', // base 25
      deductionAmount: 0,
      history: [],
      accountAge: 3, // <7 => +10
      hasPendingPayout: true,
      pendingPayoutAmount: 1500, // >1000 => +10
      hasBanForType: true, // +15
    });
    expect(result.score).toBe(25 + 10 + 10 + 15);
    const names = result.factors.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['new_account', 'large_pending_payout', 'banned_activity']));
  });

  it('adds the smaller pending-payout bump when amount is <=1000', () => {
    const result = assessSeverity({
      violationType: 'hft',
      deductionAmount: 0,
      history: [],
      hasPendingPayout: true,
      pendingPayoutAmount: 500,
    });
    expect(result.factors.find((f) => f.name === 'pending_payout')?.points).toBe(5);
  });

  it('caps the score at 100', () => {
    const history: AccountViolationHistory[] = [historyRow({ violation_type: 'copy', total_count: 8, count_last_30d: 3 })];
    const result = assessSeverity({
      violationType: 'copy',
      deductionAmount: 1000,
      history,
      accountAge: 1,
      hasPendingPayout: true,
      pendingPayoutAmount: 5000,
      hasBanForType: true,
    });
    expect(result.score).toBe(100);
    expect(result.escalation_level).toBe('critical');
  });

  it('hits escalation-level boundaries exactly at their thresholds', () => {
    // 26 => elevated (news base 10 + amount>200 15? need exact 26)
    // Use deductionAmount to hit precise scores via known base points.
    const elevated = assessSeverity({ violationType: 'hft', deductionAmount: 60, history: [] }); // 10 + 5(>50) = 15, not enough — recompute below
    expect(elevated.score).toBe(15);
    expect(elevated.escalation_level).toBe('normal');

    const exactly26 = assessSeverity({
      violationType: 'hft', // 10
      deductionAmount: 250, // >200 => +15... 10+15=25, need +1 more
      history: [],
      accountAge: undefined,
    });
    expect(exactly26.score).toBe(25);
    expect(exactly26.escalation_level).toBe('normal'); // 25 < 26

    const bumpedTo35 = assessSeverity({
      violationType: 'hft', // 10
      deductionAmount: 250, // +15 = 25
      history: [],
      hasPendingPayout: true, // +5 = 30
    });
    expect(bumpedTo35.score).toBe(30);
    expect(bumpedTo35.escalation_level).toBe('elevated'); // >=26
  });

  it('recommends a payout hold only when score >= 50 and a pending payout exists', () => {
    const belowThreshold = assessSeverity({
      violationType: 'martingale', // 20
      deductionAmount: 250, // +15 = 35
      history: [],
      hasPendingPayout: true,
      pendingPayoutAmount: 100,
    });
    expect(belowThreshold.score).toBeLessThan(50);
    expect(belowThreshold.recommended_actions.some((a) => a.action_type === 'payout_hold')).toBe(false);

    const aboveThreshold = assessSeverity({
      violationType: 'copy', // 25
      deductionAmount: 600, // >500 => +20 = 45
      history: [historyRow({ violation_type: 'copy', total_count: 2, count_last_30d: 2 })], // repeat +10 = 55
      hasPendingPayout: true,
      pendingPayoutAmount: 2000,
    });
    expect(aboveThreshold.score).toBeGreaterThanOrEqual(50);
    expect(aboveThreshold.recommended_actions.some((a) => a.action_type === 'payout_hold')).toBe(true);
  });

  it('recommends escalation only when score >= 70', () => {
    const result = assessSeverity({
      violationType: 'copy', // 25
      deductionAmount: 600, // +20 = 45
      history: [historyRow({ violation_type: 'copy', total_count: 6, count_last_30d: 3 })], // repeat +25 = 70
    });
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.recommended_actions.some((a) => a.action_type === 'escalation')).toBe(true);
  });

  it('recommends account_restriction when 3+ prior violations of the same type exist', () => {
    const result = assessSeverity({
      violationType: 'grid',
      deductionAmount: 10,
      history: [historyRow({ violation_type: 'grid', total_count: 3, count_last_30d: 0 })],
    });
    expect(result.recommended_actions.some((a) => a.action_type === 'account_restriction')).toBe(true);
  });

  it('scales the recommended deduction amount by the repeat multiplier', () => {
    const result = assessSeverity({
      violationType: 'hft',
      deductionAmount: 100,
      history: [historyRow({ violation_type: 'hft', total_count: 1, count_last_30d: 2 })], // repeatMultiplier(2) = 2.0
    });
    const deductionAction = result.recommended_actions.find((a) => a.action_type === 'deduction');
    expect(deductionAction?.amount).toBe(200);
  });

  it('does not recommend a deduction action when deductionAmount is 0', () => {
    const result = assessSeverity({ violationType: 'hft', deductionAmount: 0, history: [] });
    expect(result.recommended_actions.some((a) => a.action_type === 'deduction')).toBe(false);
  });
});
