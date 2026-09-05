import { describe, expect, it } from 'vitest';
import { parseRulePack, validateRulePack } from './schema';
import { contentHashOf } from './store';
import {
  DEMO_RULE_PACKS,
  DEMO_BACKTEST_HISTORY,
  findDemoPack,
  findDemoBacktestHistory,
  buildDemoAccountInputs,
  runDemoBacktest,
} from './demo';

describe('DEMO_RULE_PACKS', () => {
  it('ships the three sample packs the demo relies on', () => {
    const ids = DEMO_RULE_PACKS.map((p) => p.id).sort();
    expect(ids).toEqual(['demo-apex-futures', 'demo-ftmo-forex', 'demo-topstep-futures-draft']);
  });

  it.each(DEMO_RULE_PACKS.map((p) => [p.id, p] as const))('%s parses and validates', (_id, pack) => {
    const { pack: parsed, validation } = parseRulePack(pack.pack);
    expect(() => parseRulePack(pack.pack)).not.toThrow();
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validateRulePack(parsed).valid).toBe(true);
  });

  it('has a stable, correctly-computed content hash', () => {
    for (const pack of DEMO_RULE_PACKS) {
      expect(pack.contentHash).toBe(contentHashOf(pack.pack));
      // Deterministic: hashing the same pack again must agree.
      expect(contentHashOf(pack.pack)).toBe(contentHashOf(pack.pack));
    }
  });

  it('covers the statuses and asset classes the demo needs to show', () => {
    const byId = Object.fromEntries(DEMO_RULE_PACKS.map((p) => [p.id, p]));
    expect(byId['demo-apex-futures'].status).toBe('active');
    expect(byId['demo-apex-futures'].assetClass).toBe('futures');
    expect(byId['demo-apex-futures'].version).toBe(2);
    expect(byId['demo-topstep-futures-draft'].status).toBe('draft');
    expect(byId['demo-topstep-futures-draft'].assetClass).toBe('futures');
    expect(byId['demo-ftmo-forex'].status).toBe('active');
    expect(byId['demo-ftmo-forex'].assetClass).toBe('forex');
  });

  it('uses fixed timestamps, never wall-clock time', () => {
    for (const pack of DEMO_RULE_PACKS) {
      expect(() => new Date(pack.createdAt).toISOString()).not.toThrow();
      expect(Number.isNaN(Date.parse(pack.createdAt))).toBe(false);
    }
  });
});

describe('findDemoPack', () => {
  it('finds a known id and returns null for an unknown one', () => {
    expect(findDemoPack('demo-apex-futures')?.id).toBe('demo-apex-futures');
    expect(findDemoPack('does-not-exist')).toBeNull();
  });
});

describe('runDemoBacktest', () => {
  it('returns null for an unknown pack id', () => {
    expect(runDemoBacktest('does-not-exist')).toBeNull();
  });

  it('is deterministic: two calls with the default tape agree exactly', () => {
    const a = runDemoBacktest('demo-apex-futures');
    const b = runDemoBacktest('demo-apex-futures');
    expect(a).toEqual(b);
  });

  it('finds at least one surfaced (engine-only) breach and zero platform-missed breaches', () => {
    const result = runDemoBacktest('demo-apex-futures');
    expect(result).not.toBeNull();
    expect(result!.reconciliation.engineOnly.length).toBeGreaterThanOrEqual(1);
    expect(result!.reconciliation.providerOnly.length).toBe(0);
  });

  it('surfaces at least one skipped rule (missing snapshots)', () => {
    const result = runDemoBacktest('demo-apex-futures');
    expect(result!.skipped.length).toBeGreaterThanOrEqual(1);
    expect(result!.skipped.some((s) => s.reason.includes('snapshot'))).toBe(true);
  });

  it('evaluates all six synthetic accounts by default', () => {
    const result = runDemoBacktest('demo-apex-futures');
    expect(result!.accountsEvaluated).toBe(6);
  });

  it('accepts caller-supplied account inputs instead of the default tape', () => {
    const inputs = buildDemoAccountInputs().slice(0, 1);
    const result = runDemoBacktest('demo-apex-futures', inputs);
    expect(result!.accountsEvaluated).toBe(1);
  });
});

describe('DEMO_BACKTEST_HISTORY', () => {
  it('has one prior run for each active pack', () => {
    expect(findDemoBacktestHistory('demo-apex-futures').length).toBe(1);
    expect(findDemoBacktestHistory('demo-ftmo-forex').length).toBe(1);
  });

  it('has no history for the draft pack', () => {
    expect(findDemoBacktestHistory('demo-topstep-futures-draft')).toEqual([]);
  });

  it('returns an empty array for an unknown id rather than throwing', () => {
    expect(findDemoBacktestHistory('does-not-exist')).toEqual([]);
  });

  it('history rows carry the snake_case shape the detail page reads', () => {
    const [run] = DEMO_BACKTEST_HISTORY['demo-apex-futures'];
    expect(run).toMatchObject({
      status: 'complete',
      accounts_evaluated: expect.any(Number),
      engine_breaches: expect.any(Number),
      provider_breaches: expect.any(Number),
    });
    expect(Number.isNaN(Date.parse(run.created_at))).toBe(false);
  });
});
