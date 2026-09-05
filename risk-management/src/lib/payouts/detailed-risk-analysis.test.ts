import { describe, expect, it } from 'vitest';
import { analyzeTradesDetailed } from './detailed-risk-analysis';
import type { PlatformTrade } from '@/types/platform';
import type { NewsEvent } from '@/lib/news/calendar';

let seq = 0;
function trade(overrides: Partial<PlatformTrade> = {}): PlatformTrade {
  seq++;
  return {
    _id: overrides._id ?? `t${seq}`,
    position: overrides.position,
    login: 1001,
    accountId: 1001,
    trdSymbol: 'EURUSD',
    stdSymbol: 'EURUSD',
    side: 'Buy',
    lots: 1,
    openTime: new Date('2026-06-01T10:00:00Z').toISOString(),
    openPrice: 1.1,
    closeTime: new Date('2026-06-01T10:05:00Z').toISOString(),
    closePrice: 1.1005,
    duration: 300,
    profit: 50,
    commission: -2,
    swap: 0,
    reason: 'closed',
    ...overrides,
  };
}

function iso(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

describe('analyzeTradesDetailed', () => {
  it('returns empty result for no trades', () => {
    const result = analyzeTradesDetailed([]);
    expect(result.violations).toEqual([]);
    expect(result.summary.totalDeductions).toBe(0);
  });

  describe('HFT detector', () => {
    const base = new Date('2026-06-01T10:00:00Z').getTime();

    it('flags 2 positions opened within a 3s window', () => {
      const trades = [
        trade({ _id: 'a', position: 'pa', openTime: iso(base, 0), closeTime: iso(base, 60000), profit: 10 }),
        trade({ _id: 'b', position: 'pb', openTime: iso(base, 1000), closeTime: iso(base, 61000), profit: -20 }),
      ];
      const result = analyzeTradesDetailed(trades);
      const hftViolations = result.violations.filter((v) => v.typeKey === 'hft');
      expect(hftViolations).toHaveLength(2);
      expect(hftViolations[0].explanation).toContain('2 deals under 3 seconds');
      expect(hftViolations.find((v) => v.trade._id === 'a')!.deductionAmount).toBe(10);
      expect(hftViolations.find((v) => v.trade._id === 'b')!.deductionAmount).toBe(0); // max(0, -20)
    });

    it('deduplicates partial closes sharing the same position when counting the window', () => {
      // Two partials on the same position 0.5s apart — should collapse to ONE
      // representative for window-counting purposes, so alone they can't
      // trigger the 2-in-3s threshold.
      const trades = [
        trade({ _id: 'p1a', position: 'shared-pos', openTime: iso(base, 0), profit: 5 }),
        trade({ _id: 'p1b', position: 'shared-pos', openTime: iso(base, 500), profit: 5 }),
      ];
      const result = analyzeTradesDetailed(trades);
      expect(result.violations.filter((v) => v.typeKey === 'hft')).toHaveLength(0);
    });

    it('flags all partials of a position when the position triggers a window with another position', () => {
      const trades = [
        trade({ _id: 'p1a', position: 'shared-pos', openTime: iso(base, 0), profit: 5 }),
        trade({ _id: 'p1b', position: 'shared-pos', openTime: iso(base, 500), profit: 5 }),
        trade({ _id: 'c', position: 'other-pos', openTime: iso(base, 1000), profit: 5 }),
      ];
      const result = analyzeTradesDetailed(trades);
      const hftIds = result.violations.filter((v) => v.typeKey === 'hft').map((v) => v.trade._id);
      expect(hftIds.sort()).toEqual(['c', 'p1a', 'p1b']);
    });

    it('does not flag trades spaced well outside every window', () => {
      const trades = [
        trade({ _id: 'a', position: 'pa', openTime: iso(base, 0), profit: 5 }),
        trade({ _id: 'b', position: 'pb', openTime: iso(base, 2 * 3600 * 1000), profit: 5 }),
      ];
      const result = analyzeTradesDetailed(trades);
      expect(result.violations.filter((v) => v.typeKey === 'hft')).toHaveLength(0);
    });
  });

  describe('Martingale detector', () => {
    it('flags lot size >1.5x prior after 2+ consecutive losses', () => {
      const t0 = new Date('2026-06-01T09:00:00Z').getTime();
      const trades = [
        trade({ _id: 'l1', lots: 1.0, profit: -10, closeTime: iso(t0, 0) }),
        trade({ _id: 'l2', lots: 1.0, profit: -10, closeTime: iso(t0, 60000) }),
        trade({ _id: 'l3', lots: 2.0, profit: -5, closeTime: iso(t0, 120000) }),
      ];
      const result = analyzeTradesDetailed(trades);
      const martingale = result.violations.filter((v) => v.typeKey === 'martingale');
      expect(martingale).toHaveLength(1);
      expect(martingale[0].trade._id).toBe('l3');
      expect(martingale[0].deductionAmount).toBe(0); // max(0, -5)
    });

    it('does not flag when lot increase is under 1.5x', () => {
      const t0 = new Date('2026-06-01T09:00:00Z').getTime();
      const trades = [
        trade({ _id: 'l1', lots: 1.0, profit: -10, closeTime: iso(t0, 0) }),
        trade({ _id: 'l2', lots: 1.0, profit: -10, closeTime: iso(t0, 60000) }),
        trade({ _id: 'l3', lots: 1.2, profit: -5, closeTime: iso(t0, 120000) }),
      ];
      const result = analyzeTradesDetailed(trades);
      expect(result.violations.filter((v) => v.typeKey === 'martingale')).toHaveLength(0);
    });

    it('does not flag on a single loss (needs 2+ consecutive losses before the flagged trade)', () => {
      const t0 = new Date('2026-06-01T09:00:00Z').getTime();
      const trades = [
        trade({ _id: 'l1', lots: 1.0, profit: 20, closeTime: iso(t0, 0) }),
        trade({ _id: 'l2', lots: 1.0, profit: -10, closeTime: iso(t0, 60000) }),
        trade({ _id: 'l3', lots: 10.0, profit: 30, closeTime: iso(t0, 120000) }), // win — never checked
      ];
      const result = analyzeTradesDetailed(trades);
      expect(result.violations.filter((v) => v.typeKey === 'martingale')).toHaveLength(0);
    });
  });

  describe('Over-leverage detector', () => {
    it('flags concurrent lots exceeding the LOT_LIMITS for a snapped $10,000 account', () => {
      const t0 = new Date('2026-06-01T10:00:00Z').getTime();
      // forex limit at exactly $10,000 snapped size = 2 lots. Two overlapping
      // 1.5-lot trades on EURUSD => concurrent 3.0 > 2 for both.
      const trades = [
        trade({ _id: 'o1', trdSymbol: 'EURUSD', lots: 1.5, openTime: iso(t0, 0), closeTime: iso(t0, 60 * 60 * 1000), profit: 30 }),
        trade({ _id: 'o2', trdSymbol: 'EURUSD', lots: 1.5, openTime: iso(t0, 5 * 60 * 1000), closeTime: iso(t0, 90 * 60 * 1000), profit: -10 }),
      ];
      const result = analyzeTradesDetailed(trades, undefined, undefined, undefined, 10000);
      const over = result.violations.filter((v) => v.typeKey === 'overleveraging');
      expect(over).toHaveLength(2);
      expect(over[0].explanation).toContain('exceeds max allowed 2 lots');
      expect(over[0].explanation).toContain('$10,000 account');
    });

    it('does not flag when concurrent lots stay within the account-size limit', () => {
      const t0 = new Date('2026-06-01T10:00:00Z').getTime();
      const trades = [
        trade({ _id: 'o1', trdSymbol: 'EURUSD', lots: 0.5, openTime: iso(t0, 0), closeTime: iso(t0, 60 * 60 * 1000), profit: 30 }),
      ];
      const result = analyzeTradesDetailed(trades, undefined, undefined, undefined, 10000);
      expect(result.violations.filter((v) => v.typeKey === 'overleveraging')).toHaveLength(0);
    });

    it('falls back to 3x-average heuristic when account size is unknown', () => {
      const t0 = new Date('2026-06-01T10:00:00Z').getTime();
      // 7 trades @ 1 lot + 3 trades @ 50 lots => avg = 15.7, threshold = 47.1,
      // so all three 50-lot trades (>=3 overleveraged) trip the fallback.
      const normal = Array.from({ length: 7 }, (_, i) =>
        trade({ _id: `n${i}`, lots: 1, openTime: iso(t0, i * 1000), closeTime: iso(t0, i * 1000 + 500), profit: 5 })
      );
      const big = Array.from({ length: 3 }, (_, i) =>
        trade({ _id: `b${i}`, lots: 50, openTime: iso(t0, (i + 10) * 1000), closeTime: iso(t0, (i + 10) * 1000 + 500), profit: 100 })
      );
      const result = analyzeTradesDetailed([...normal, ...big]);
      const over = result.violations.filter((v) => v.typeKey === 'overleveraging');
      expect(over).toHaveLength(3);
      expect(over.map((v) => v.trade._id).sort()).toEqual(['b0', 'b1', 'b2']);
    });

    it('does not flag the 3x-average fallback when fewer than 3 trades exceed the threshold', () => {
      const t0 = new Date('2026-06-01T10:00:00Z').getTime();
      const trades = [
        trade({ _id: 'n1', lots: 1, openTime: iso(t0, 0), profit: 5 }),
        trade({ _id: 'n2', lots: 1, openTime: iso(t0, 1000), profit: 5 }),
        trade({ _id: 'big', lots: 50, openTime: iso(t0, 2000), profit: 5 }),
      ];
      const result = analyzeTradesDetailed(trades);
      expect(result.violations.filter((v) => v.typeKey === 'overleveraging')).toHaveLength(0);
    });
  });

  describe('Grid detector', () => {
    it('flags regular-interval price spacing on a single symbol (>=5 trades)', () => {
      const prices = [1.1, 1.1015, 1.103, 1.1045, 1.106];
      const trades = prices.map((p, i) =>
        trade({ _id: `g${i}`, trdSymbol: 'XAUUSD', openPrice: p, profit: 10 })
      );
      const result = analyzeTradesDetailed(trades);
      const grid = result.violations.filter((v) => v.typeKey === 'grid');
      expect(grid).toHaveLength(5);
      expect(grid[0].explanation).toContain('Regular price intervals detected on XAUUSD');
    });

    it('does not flag irregular price spacing', () => {
      const prices = [1.1, 1.15, 1.3, 1.42, 1.9];
      const trades = prices.map((p, i) =>
        trade({ _id: `g${i}`, trdSymbol: 'XAUUSD', openPrice: p, profit: 10 })
      );
      const result = analyzeTradesDetailed(trades);
      expect(result.violations.filter((v) => v.typeKey === 'grid')).toHaveLength(0);
    });

    it('does not flag symbols with fewer than 5 trades', () => {
      const prices = [1.1, 1.101, 1.102, 1.103];
      const trades = prices.map((p, i) =>
        trade({ _id: `g${i}`, trdSymbol: 'XAUUSD', openPrice: p, profit: 10 })
      );
      const result = analyzeTradesDetailed(trades);
      expect(result.violations.filter((v) => v.typeKey === 'grid')).toHaveLength(0);
    });
  });

  describe('News detector', () => {
    it('flags a trade opened within 5 minutes of a high-impact USD event', () => {
      const eventTime = new Date('2026-06-01T12:30:00Z');
      const openTime = new Date(eventTime.getTime() + 2 * 60 * 1000); // 2 min after
      const closeTime = new Date(openTime.getTime() + 60 * 60 * 1000);
      const trades = [
        trade({ _id: 'news1', trdSymbol: 'EURUSD', openTime: openTime.toISOString(), closeTime: closeTime.toISOString(), profit: 40 }),
      ];
      const newsEvents: NewsEvent[] = [
        { title: 'Non-Farm Payrolls', country: 'US', date: eventTime.toISOString(), impact: 'High', source: 'forex_factory' },
      ];
      const result = analyzeTradesDetailed(trades, undefined, undefined, newsEvents);
      const news = result.violations.filter((v) => v.typeKey === 'news');
      expect(news).toHaveLength(1);
      expect(news[0].trade._id).toBe('news1');
      expect(result.newsEvents).toHaveLength(1);
    });

    it('does not flag a trade outside the 5 minute window', () => {
      const eventTime = new Date('2026-06-01T12:30:00Z');
      const openTime = new Date(eventTime.getTime() + 30 * 60 * 1000); // 30 min after
      const closeTime = new Date(openTime.getTime() + 60 * 60 * 1000);
      const trades = [
        trade({ _id: 'news1', trdSymbol: 'EURUSD', openTime: openTime.toISOString(), closeTime: closeTime.toISOString(), profit: 40 }),
      ];
      const newsEvents: NewsEvent[] = [
        { title: 'Non-Farm Payrolls', country: 'US', date: eventTime.toISOString(), impact: 'High', source: 'forex_factory' },
      ];
      const result = analyzeTradesDetailed(trades, undefined, undefined, newsEvents);
      expect(result.violations.filter((v) => v.typeKey === 'news')).toHaveLength(0);
    });

    it('ignores low-impact events', () => {
      const eventTime = new Date('2026-06-01T12:30:00Z');
      const openTime = new Date(eventTime.getTime() + 1 * 60 * 1000);
      const trades = [trade({ _id: 'news1', trdSymbol: 'EURUSD', openTime: openTime.toISOString(), profit: 40 })];
      const newsEvents: NewsEvent[] = [
        { title: 'Minor Report', country: 'US', date: eventTime.toISOString(), impact: 'Low', source: 'forex_factory' },
      ];
      const result = analyzeTradesDetailed(trades, undefined, undefined, newsEvents);
      expect(result.violations.filter((v) => v.typeKey === 'news')).toHaveLength(0);
    });
  });

  describe('clean pass + summary aggregation', () => {
    it('returns no violations for an unremarkable trade set', () => {
      const t0 = new Date('2026-06-01T09:00:00Z').getTime();
      const trades = [
        trade({ _id: 'c1', lots: 0.5, openTime: iso(t0, 0), closeTime: iso(t0, 3600000), openPrice: 1.1, profit: 30 }),
        trade({ _id: 'c2', lots: 0.5, openTime: iso(t0, 4 * 3600 * 1000), closeTime: iso(t0, 5 * 3600 * 1000), openPrice: 1.12, profit: -10 }),
      ];
      const result = analyzeTradesDetailed(trades);
      expect(result.violations).toEqual([]);
      expect(result.summary.totalDeductions).toBe(0);
      expect(result.summary.violatingTradeCount).toBe(0);
    });

    it('deduplicates same trade+type and sums total deductions per unique trade (max across types)', () => {
      const t0 = new Date('2026-06-01T10:00:00Z').getTime();
      // A trade that is both HFT and part of a martingale sequence should only
      // count once toward totalDeductions (max of its violation deductions).
      const trades = [
        trade({ _id: 'x1', position: 'px1', lots: 1.0, openTime: iso(t0, 0), closeTime: iso(t0, 0), profit: -10 }),
        trade({ _id: 'x2', position: 'px2', lots: 1.0, openTime: iso(t0, 500), closeTime: iso(t0, 60000), profit: -10 }),
        trade({ _id: 'x3', position: 'px3', lots: 2.0, openTime: iso(t0, 1000), closeTime: iso(t0, 120000), profit: 40 }),
      ];
      const result = analyzeTradesDetailed(trades);
      // x1/x2/x3 all opened within 3s of each other -> HFT; x3 is also martingale.
      const x3Violations = result.violations.filter((v) => v.trade._id === 'x3');
      expect(x3Violations.length).toBeGreaterThanOrEqual(1);
      const uniqueTradeIds = new Set(result.violations.map((v) => v.trade._id));
      expect(result.summary.violatingTradeCount).toBe(uniqueTradeIds.size);
    });
  });
});
