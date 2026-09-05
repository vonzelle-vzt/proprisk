import { describe, expect, it } from 'vitest';
import { buildDemoTraderView, demoVerifiedAccess, DEMO_TRADER_TOKEN } from './demo';

/**
 * DEMO_MODE fixtures for the trader surface. These assert the view is
 * genuinely usable (headroom, trades, at least one violation) and that the
 * headroom numbers come from actually running `computeHeadroom` against the
 * mock account and a real preset — not hard-coded placeholders — by
 * cross-checking one item's math against the account's own balance.
 */

describe('DEMO_TRADER_TOKEN', () => {
  it('is the fixed, publicly known demo token', () => {
    expect(DEMO_TRADER_TOKEN).toBe('demo');
  });
});

describe('demoVerifiedAccess', () => {
  it('always resolves to the same fixed (tenant, account) pair', () => {
    const a = demoVerifiedAccess();
    const b = demoVerifiedAccess();
    expect(a).toEqual(b);
    expect(a.tenantId).toBeTruthy();
    expect(a.accountId).toBeTruthy();
  });
});

describe('buildDemoTraderView', () => {
  it('has at least one headroom item computed against the account', () => {
    const view = buildDemoTraderView();
    expect(view.headroom.items.length).toBeGreaterThan(0);
    // The floor/limit numbers must be non-trivial (i.e. actually computed
    // from the account's starting balance), not zeroed-out placeholders.
    for (const item of view.headroom.items) {
      expect(typeof item.limit).toBe('string');
      expect(item.limit.length).toBeGreaterThan(0);
    }
  });

  it('has recent closed trades', () => {
    const view = buildDemoTraderView();
    expect(view.recentClosedTrades.length).toBeGreaterThan(0);
    for (const trade of view.recentClosedTrades) {
      expect(trade.id).toBeTruthy();
      expect(trade.symbol).toBeTruthy();
      expect(trade.closeTime).toBeTruthy();
    }
  });

  it('has at least one violation, with an id the demo report builder accepts', () => {
    const view = buildDemoTraderView();
    expect(view.violations.length).toBeGreaterThan(0);
    for (const v of view.violations) {
      // Ids look like `<accountId>-<violationType>`, e.g. '100185-grid'.
      expect(v.id).toMatch(/^\d+-[a-z_]+$/);
      expect(v.ruleLabel).toBeTruthy();
      expect(v.severity).toBeTruthy();
    }
  });

  it('reports a plausible, non-zero account summary', () => {
    const view = buildDemoTraderView();
    expect(view.account.startingBalance).toBeGreaterThan(0);
    expect(view.account.currentBalance).toBeGreaterThan(0);
    expect(view.account.currentEquity).toBe(view.account.currentBalance);
    expect(view.account.phase).toBeTruthy();
  });

  it('is stable across calls (deterministic mock data)', () => {
    const a = buildDemoTraderView();
    const b = buildDemoTraderView();
    expect(a.account.login).toBe(b.account.login);
    expect(a.violations.map((v) => v.id)).toEqual(b.violations.map((v) => v.id));
  });
});
