import { describe, expect, it } from 'vitest';
import { evaluatePreTrade } from '@/lib/risk/pretrade';
import type { PreTradeInput, RiskRule } from '@/types/risk';

const baseInput: PreTradeInput = {
  account_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  symbol: 'EURUSD',
  direction: 'buy',
  entry_price: 1.1,
  stop_loss_price: 1.095,
  quantity: 1000,
  account_balance: 10000,
  open_exposure_value: 2000,
  daily_realized_pnl: -100,
  consecutive_losses: 1,
};

const baseRules: RiskRule[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    type: 'max_daily_loss',
    enabled: true,
    threshold: 800,
    warning_threshold: 500,
    instrument_list: null,
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    type: 'max_position_risk_pct',
    enabled: true,
    threshold: 2,
    warning_threshold: 1.2,
    instrument_list: null,
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    type: 'max_consecutive_losses',
    enabled: true,
    threshold: 4,
    warning_threshold: 2,
    instrument_list: null,
  },
  {
    id: '44444444-4444-4444-4444-444444444444',
    type: 'instrument_blocklist',
    enabled: true,
    threshold: null,
    warning_threshold: null,
    instrument_list: ['XAUUSD'],
  },
];

describe('pre-trade evaluator', () => {
  it('returns pass for an allowed trade', () => {
    const decision = evaluatePreTrade(baseInput, baseRules);
    expect(decision.result).toBe('pass');
    expect(decision.violations).toHaveLength(0);
  });

  it('returns block for blocklisted symbols', () => {
    const decision = evaluatePreTrade({ ...baseInput, symbol: 'XAUUSD' }, baseRules);
    expect(decision.result).toBe('block');
    expect(decision.violations.some((v) => v.rule_type === 'instrument_blocklist')).toBe(true);
  });

  it('is deterministic for identical input', () => {
    const first = evaluatePreTrade(baseInput, baseRules);
    const second = evaluatePreTrade(baseInput, baseRules);
    expect(first).toEqual(second);
  });

  it('returns warn when within warning threshold', () => {
    const decision = evaluatePreTrade(
      {
        ...baseInput,
        quantity: 25000, // risk ~1.25%
      },
      baseRules
    );
    expect(decision.result).toBe('warn');
    expect(decision.violations.some((v) => v.severity === 'medium' || v.severity === 'low')).toBe(
      true
    );
  });

  it('returns block and suggestions when risk percent exceeds hard cap', () => {
    const decision = evaluatePreTrade(
      {
        ...baseInput,
        quantity: 45000, // risk ~2.25%
      },
      baseRules
    );
    expect(decision.result).toBe('block');
    expect(decision.violations.some((v) => v.rule_type === 'max_position_risk_pct')).toBe(true);
    expect(decision.suggestions.length).toBeGreaterThan(0);
  });
});
