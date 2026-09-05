import { describe, expect, it } from 'vitest';
import { computeLiabilityForecastCore, deriveHistoricalRates } from './liability';
import type { MockPayoutDecision } from '@/lib/mock/dataset.network';

const ASOF = new Date('2026-06-15T00:00:00Z');

describe('computeLiabilityForecastCore', () => {
  it('buckets a pending payout onto its expected maturity day (requestedAt + 3 days)', () => {
    const forecast = computeLiabilityForecastCore({
      asOf: ASOF,
      horizonDays: 7,
      pending: [{ amount: 1000, requestedAt: '2026-06-14T00:00:00Z' }], // matures 06-17 = day 2
      fundedNearTargetCount: 0,
      avgPipelinePayoutEstimate: 0,
      approvalRate: 1,
      avgDeductionRate: 0,
    });
    // With approvalRate=1, avgDeductionRate=0, pendingComponent = full amount.
    expect(forecast.points[2].pendingComponent).toBe(1000);
    expect(forecast.points[0].pendingComponent).toBe(0);
    expect(forecast.points[1].pendingComponent).toBe(0);
  });

  it('collapses a payout requested further in the past than the processing lag onto day 0', () => {
    const forecast = computeLiabilityForecastCore({
      asOf: ASOF,
      horizonDays: 7,
      pending: [{ amount: 500, requestedAt: '2026-06-01T00:00:00Z' }], // 14 days ago, way past the 3-day lag
      fundedNearTargetCount: 0,
      avgPipelinePayoutEstimate: 0,
      approvalRate: 1,
      avgDeductionRate: 0,
    });
    expect(forecast.points[0].pendingComponent).toBe(500);
  });

  it('spreads the pipeline (funded-near-target) component evenly across the horizon', () => {
    const forecast = computeLiabilityForecastCore({
      asOf: ASOF,
      horizonDays: 7,
      pending: [],
      fundedNearTargetCount: 7,
      avgPipelinePayoutEstimate: 1000,
      approvalRate: 1,
      avgDeductionRate: 0,
    });
    // total pipeline gross = 7 * 1000 = 7000, spread over 7 days = 1000/day
    for (const point of forecast.points) {
      expect(point.pipelineComponent).toBe(1000);
    }
  });

  it('keeps p90 >= p50 on every point (pessimistic band invariant)', () => {
    const forecast = computeLiabilityForecastCore({
      asOf: ASOF,
      horizonDays: 30,
      pending: [
        { amount: 1200, requestedAt: '2026-06-10T00:00:00Z' },
        { amount: 800, requestedAt: '2026-06-13T00:00:00Z' },
      ],
      fundedNearTargetCount: 4,
      avgPipelinePayoutEstimate: 900,
      approvalRate: 0.72,
      avgDeductionRate: 0.18,
    });
    for (const point of forecast.points) {
      expect(point.p90).toBeGreaterThanOrEqual(point.p50);
    }
    expect(forecast.totals.expectedP90).toBeGreaterThanOrEqual(forecast.totals.expectedP50);
  });

  it('reconciles totals with the sum of per-day points', () => {
    const forecast = computeLiabilityForecastCore({
      asOf: ASOF,
      horizonDays: 7,
      pending: [
        { amount: 1000, requestedAt: '2026-06-14T00:00:00Z' },
        { amount: 2000, requestedAt: '2026-06-10T00:00:00Z' },
      ],
      fundedNearTargetCount: 3,
      avgPipelinePayoutEstimate: 500,
      approvalRate: 0.8,
      avgDeductionRate: 0.1,
    });
    const sumP50 = forecast.points.reduce((s, p) => s + p.p50, 0);
    const sumP90 = forecast.points.reduce((s, p) => s + p.p90, 0);
    // Totals are now the sum of the same rounded per-day point values shown to
    // the user, so they reconcile exactly (no unrounded-vs-rounded drift).
    expect(forecast.totals.expectedP50).toBe(Math.round(sumP50 * 100) / 100);
    expect(forecast.totals.expectedP90).toBe(Math.round(sumP90 * 100) / 100);
    expect(forecast.totals.pendingNow).toBe(3000);
  });

  it('clamps out-of-range approval/deduction rate overrides into [0,1]', () => {
    const forecast = computeLiabilityForecastCore({
      asOf: ASOF,
      horizonDays: 7,
      pending: [{ amount: 1000, requestedAt: '2026-06-14T00:00:00Z' }],
      fundedNearTargetCount: 0,
      avgPipelinePayoutEstimate: 0,
      approvalRate: 1.5, // clamps to 1
      avgDeductionRate: -0.2, // clamps to 0
    });
    expect(forecast.assumptions.approvalRate).toBe(1);
    expect(forecast.assumptions.avgDeductionRate).toBe(0);
  });

  it('clamps p90 approval rate at 1 and p90 deduction rate at 0 at the edges', () => {
    const forecast = computeLiabilityForecastCore({
      asOf: ASOF,
      horizonDays: 7,
      pending: [{ amount: 1000, requestedAt: '2026-06-14T00:00:00Z' }],
      fundedNearTargetCount: 0,
      avgPipelinePayoutEstimate: 0,
      approvalRate: 0.95, // +0.1 would exceed 1, should clamp
      avgDeductionRate: 0.02, // -0.05 would go negative, should clamp to 0
    });
    // p90 for the matured day should equal grossPending * 1 * (1-0) = full amount
    const maturedPoint = forecast.points.find((p) => p.p90 > 0)!;
    expect(maturedPoint.p90).toBe(1000);
  });
});

describe('deriveHistoricalRates', () => {
  function decision(overrides: Partial<MockPayoutDecision> = {}): MockPayoutDecision {
    return {
      id: 'DEC-1',
      payoutId: 'PO-1',
      accountId: 'acc-1',
      assetClass: 'forex',
      decision: 'approve',
      actor: 'system',
      decidedAt: new Date().toISOString(),
      rationale: {
        citedRules: [],
        math: { grossProfit: 1000, totalDeductions: 100, profitSharePct: 80, clientShareOfNet: 720, finalAmount: 720 },
      },
      explanation: '',
      ...overrides,
    };
  }

  it('falls back to documented defaults (0.72/0.18) with fewer than 3 samples', () => {
    const rates = deriveHistoricalRates([decision(), decision()]);
    expect(rates.approvalRate).toBe(0.72);
    expect(rates.avgDeductionRate).toBe(0.18);
  });

  it('falls back to defaults for an empty or undefined history', () => {
    expect(deriveHistoricalRates([])).toEqual({ approvalRate: 0.72, avgDeductionRate: 0.18 });
    expect(deriveHistoricalRates(undefined as unknown as MockPayoutDecision[])).toEqual({
      approvalRate: 0.72,
      avgDeductionRate: 0.18,
    });
  });

  it('derives approval rate and deduction rate from a sufficient sample', () => {
    const decisions = [
      decision({ decision: 'approve', rationale: { citedRules: [], math: { grossProfit: 1000, totalDeductions: 200, profitSharePct: 80, clientShareOfNet: 640, finalAmount: 640 } } }),
      decision({ decision: 'preapprove', rationale: { citedRules: [], math: { grossProfit: 1000, totalDeductions: 100, profitSharePct: 80, clientShareOfNet: 720, finalAmount: 720 } } }),
      decision({ decision: 'reject', rationale: { citedRules: [], math: { grossProfit: 1000, totalDeductions: 900, profitSharePct: 80, clientShareOfNet: 80, finalAmount: 80 } } }),
      decision({ decision: 'hold', rationale: { citedRules: [], math: { grossProfit: 1000, totalDeductions: 300, profitSharePct: 80, clientShareOfNet: 560, finalAmount: 560 } } }),
    ];
    const rates = deriveHistoricalRates(decisions);
    // approve + preapprove = 2 of 4 => 0.5
    expect(rates.approvalRate).toBe(0.5);
    // avg deduction rate across all 4 (all have grossProfit > 0): (0.2+0.1+0.9+0.3)/4 = 0.375
    expect(rates.avgDeductionRate).toBeCloseTo(0.375, 5);
  });
});
