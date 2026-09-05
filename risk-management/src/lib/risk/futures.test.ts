import { describe, expect, it } from 'vitest';
import {
  detectDailyLoss,
  detectTrailingDrawdown,
  detectPositionLimit,
  runFuturesAnalysis,
} from './futures/index';
import type { NormalizedAccount, NormalizedTrade } from '@/lib/providers/types';

function account(overrides: Partial<NormalizedAccount> = {}): NormalizedAccount {
  return {
    id: 'acc-1',
    provider: 'tradovate',
    providerLabel: 'Tradovate',
    assetClass: 'futures',
    login: '1001',
    email: 'trader@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
    country: 'US',
    kycStatus: 'Verified',
    isBlackListed: false,
    plan: 'Standard',
    phase: 'funded',
    status: 'active',
    canTrade: true,
    startingBalance: 50000,
    balance: 50000,
    equity: 50000,
    totalPnL: 0,
    maxDailyLossPct: 0,
    maxTrailingDrawdownPct: 0,
    maxPositionSize: 0,
    sizeUnit: 'contracts',
    banNewsTrading: false,
    banHFT: false,
    banMartingale: false,
    tradedDays: 10,
    ...overrides,
  };
}

let seq = 0;
function trade(overrides: Partial<NormalizedTrade> = {}): NormalizedTrade {
  seq++;
  return {
    id: overrides.id ?? `trade-${seq}`,
    accountId: 'acc-1',
    provider: 'tradovate',
    assetClass: 'futures',
    symbol: 'ES',
    side: 'Buy',
    sizeNative: 1,
    sizeUnit: 'contracts',
    notionalUSD: 50000,
    openTime: '2026-06-01T10:00:00Z',
    closeTime: '2026-06-01T10:30:00Z',
    openPrice: 5000,
    closePrice: 5010,
    durationSec: 1800,
    profit: 0,
    commission: -2,
    swap: 0,
    ...overrides,
  };
}

describe('detectDailyLoss', () => {
  it('flags a day whose realized loss exceeds the daily loss limit', () => {
    const acc = account({ startingBalance: 50000, maxDailyLossPct: 0.04 }); // limit = $2000
    const trades = [
      trade({ closeTime: '2026-06-01T10:00:00Z', profit: -1200 }),
      trade({ closeTime: '2026-06-01T14:00:00Z', profit: -900 }),
    ];
    const violations = detectDailyLoss(acc, trades);
    expect(violations).toHaveLength(1);
    expect(violations[0].type).toBe('daily_loss');
    expect(violations[0].deductionAmount).toBeCloseTo(2100 - 2000, 5);
    expect(violations[0].affectedTradeIds.sort()).toEqual(trades.map((t) => t.id).sort());
  });

  it('does not flag a day within the daily loss limit', () => {
    const acc = account({ startingBalance: 50000, maxDailyLossPct: 0.04 });
    const trades = [trade({ closeTime: '2026-06-01T10:00:00Z', profit: -500 })];
    expect(detectDailyLoss(acc, trades)).toHaveLength(0);
  });

  it('falls back to FUTURES_CONFIG default when maxDailyLossPct is unset', () => {
    const acc = account({ startingBalance: 50000, maxDailyLossPct: 0 });
    // default_max_daily_loss_pct = 0.04 => limit $2000
    const trades = [trade({ closeTime: '2026-06-01T10:00:00Z', profit: -2500 })];
    const violations = detectDailyLoss(acc, trades);
    expect(violations).toHaveLength(1);
    expect(violations[0].deductionAmount).toBeCloseTo(500, 5);
  });

  it('buckets separate days independently', () => {
    const acc = account({ startingBalance: 50000, maxDailyLossPct: 0.04 });
    const trades = [
      trade({ id: 'd1', closeTime: '2026-06-01T10:00:00Z', profit: -2500 }),
      trade({ id: 'd2', closeTime: '2026-06-02T10:00:00Z', profit: -500 }),
    ];
    const violations = detectDailyLoss(acc, trades);
    expect(violations).toHaveLength(1);
    expect(violations[0].affectedTradeIds).toEqual(['d1']);
  });
});

describe('detectTrailingDrawdown', () => {
  it('flags trailing peak-to-trough drawdown exceeding the limit', () => {
    const acc = account({ startingBalance: 50000, maxTrailingDrawdownPct: 0.05 }); // limit = $2500
    const trades = [
      trade({ closeTime: '2026-06-01T10:00:00Z', profit: 3000 }), // equity 53000, peak 53000
      trade({ closeTime: '2026-06-01T11:00:00Z', profit: -3200 }), // equity 49800, dd = 3200
    ];
    const violations = detectTrailingDrawdown(acc, trades);
    expect(violations).toHaveLength(1);
    expect(violations[0].type).toBe('trailing_drawdown');
    expect(violations[0].deductionAmount).toBeCloseTo(3200 - 2500, 5);
  });

  it('does not flag drawdown within the limit', () => {
    const acc = account({ startingBalance: 50000, maxTrailingDrawdownPct: 0.05 });
    const trades = [
      trade({ closeTime: '2026-06-01T10:00:00Z', profit: 1000 }),
      trade({ closeTime: '2026-06-01T11:00:00Z', profit: -500 }),
    ];
    expect(detectTrailingDrawdown(acc, trades)).toHaveLength(0);
  });

  it('falls back to FUTURES_CONFIG default trailing pct when unset', () => {
    const acc = account({ startingBalance: 50000, maxTrailingDrawdownPct: 0 });
    // default_max_trailing_drawdown_pct = 0.05 => limit $2500
    const trades = [
      trade({ closeTime: '2026-06-01T10:00:00Z', profit: 4000 }),
      trade({ closeTime: '2026-06-01T11:00:00Z', profit: -4500 }),
    ];
    const violations = detectTrailingDrawdown(acc, trades);
    expect(violations).toHaveLength(1);
  });
});

describe('detectPositionLimit', () => {
  it('flags a position exceeding the account-size contract limit', () => {
    const acc = account({ startingBalance: 50000, maxPositionSize: 0 });
    // position_limits_by_size[50000] = 5
    const trades = [trade({ sizeNative: 8, profit: 200 }), trade({ sizeNative: 3, profit: -50 })];
    const violations = detectPositionLimit(acc, trades);
    expect(violations).toHaveLength(1);
    expect(violations[0].type).toBe('position_limit');
    expect(violations[0].description).toContain('8 contracts');
    expect(violations[0].deductionAmount).toBe(200); // only the positive-profit offender counted, max(0, -50) excluded... actually only offenders summed
    expect(violations[0].affectedTradeIds).toHaveLength(1);
  });

  it('does not flag positions within the account-size limit', () => {
    const acc = account({ startingBalance: 50000, maxPositionSize: 0 });
    const trades = [trade({ sizeNative: 4, profit: 100 })];
    expect(detectPositionLimit(acc, trades)).toHaveLength(0);
  });

  it('uses account.maxPositionSize override when set', () => {
    const acc = account({ startingBalance: 50000, maxPositionSize: 2 });
    const trades = [trade({ sizeNative: 3, profit: 50 })];
    const violations = detectPositionLimit(acc, trades);
    expect(violations).toHaveLength(1);
    expect(violations[0].description).toContain('2-contract limit');
  });

  it('falls back to 10 contracts when account size has no configured limit', () => {
    const acc = account({ startingBalance: 999999, maxPositionSize: 0 });
    const trades = [trade({ sizeNative: 11, profit: 50 })];
    expect(detectPositionLimit(acc, trades)).toHaveLength(1);
    const clean = detectPositionLimit(acc, [trade({ sizeNative: 9, profit: 50 })]);
    expect(clean).toHaveLength(0);
  });
});

describe('runFuturesAnalysis', () => {
  it('aggregates violations across all three detectors with a breach', () => {
    const acc = account({ startingBalance: 50000, maxDailyLossPct: 0.04, maxTrailingDrawdownPct: 0.05, maxPositionSize: 0 });
    const trades = [
      trade({ id: 't1', closeTime: '2026-06-01T10:00:00Z', profit: -2500, sizeNative: 8 }),
    ];
    const result = runFuturesAnalysis(acc, trades);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.totalDeductions).toBeGreaterThan(0);
    expect(Object.keys(result.breakdownByType).length).toBeGreaterThan(0);
    expect(result.account).toBe(acc);
  });

  it('returns no violations and zero totals for a clean account', () => {
    const acc = account({ startingBalance: 50000, maxDailyLossPct: 0.04, maxTrailingDrawdownPct: 0.05, maxPositionSize: 0 });
    const trades = [trade({ closeTime: '2026-06-01T10:00:00Z', profit: 200, sizeNative: 2 })];
    const result = runFuturesAnalysis(acc, trades);
    expect(result.violations).toHaveLength(0);
    expect(result.totalDeductions).toBe(0);
    expect(result.breakdownByType).toEqual({});
  });
});
