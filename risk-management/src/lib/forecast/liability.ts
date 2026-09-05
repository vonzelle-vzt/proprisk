/**
 * Payout-liability forecasting — deterministic, documented model (no ML,
 * no "generative simulation"). Projects expected payout liability over a
 * 7 or 30 day horizon from two components:
 *
 *   1. Pending payouts already in the queue — each "matures" (is expected to
 *      be decided) `PROCESSING_LAG_DAYS` after it was requested. Payouts
 *      requested further in the past than that lag (the common case for a
 *      queue that's been sitting for days) collapse onto day 0: they're due
 *      now, not in the future.
 *   2. The funded-account pipeline — accounts trending toward the payout-
 *      eligibility threshold but not yet in the queue. Modeled as an even
 *      arrival probability spread across the horizon (no per-account ETA
 *      is available, so a uniform arrival rate is the honest simplification).
 *
 * Both components are haircut by an approval rate and a deduction rate to
 * get expected (p50) liability. p90 nudges those two knobs pessimistically
 * (+10pp approval, -5pp deductions, both clamped to [0,1]) rather than
 * fabricating a statistical distribution — it's a defensible worst-case
 * band, not a confidence interval.
 *
 * `computeLiabilityForecastCore` is pure (all inputs passed in) so it's
 * unit-testable without touching demo/live data sources. The exported
 * `computeLiabilityForecast` is the thin async wrapper that gathers those
 * inputs from demo mock data or the live platform facade.
 */

import { DEMO_MODE, type AssetClass } from '@/lib/demo';
import { buildDashboard } from '@/lib/mock/builders';
import { MOCK_DECISION_HISTORY, type MockPayoutDecision } from '@/lib/mock/dataset.network';
import { fetchPendingPayouts } from '@/lib/platform/client';
import type { ForecastAssumptions, ForecastPoint, LiabilityForecast } from './types';

export type { ForecastAssumptions, ForecastPoint, LiabilityForecast } from './types';

// ---------------------------------------------------------------------------
// Tunable model constants (documented assumptions, not magic numbers)
// ---------------------------------------------------------------------------

/** Typical time from payout request to decision/maturity. */
const PROCESSING_LAG_DAYS = 3;

/**
 * Approximate funded/payout-eligibility profit target as a percentage of
 * starting balance. The mock account schema (and, live, the normalized
 * provider account) has no explicit per-plan profit-target field, so this
 * is a documented industry-standard proxy (prop-firm funded targets commonly
 * run 8-10% of account size) used only to classify "near target" pipeline
 * accounts, not to compute real payout amounts.
 */
const PROFIT_TARGET_PCT = 0.1;

/** ">70% of the payout-eligibility threshold" per the pipeline definition. */
const NEAR_TARGET_FLOOR_PCT = 0.7;

/** Fallback rates when historical decision data is too sparse to trust. */
const DEFAULT_APPROVAL_RATE = 0.72;
const DEFAULT_DEDUCTION_RATE = 0.18;

/** Below this many decisions, prefer the documented defaults over the sample. */
const MIN_HISTORY_SAMPLE = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function toDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

export interface ForecastPendingItem {
  amount: number;
  /** ISO date/datetime the payout was requested. */
  requestedAt: string;
}

export interface LiabilityForecastCoreInput {
  asOf: Date;
  horizonDays: 7 | 30;
  pending: ForecastPendingItem[];
  /** Count of funded accounts trending toward the payout-eligibility target. */
  fundedNearTargetCount: number;
  /** Typical payout size, used to size the pipeline's dollar contribution. */
  avgPipelinePayoutEstimate: number;
  approvalRate: number;
  avgDeductionRate: number;
}

export function computeLiabilityForecastCore(input: LiabilityForecastCoreInput): LiabilityForecast {
  const { asOf, horizonDays, pending, fundedNearTargetCount, avgPipelinePayoutEstimate } = input;
  const approvalRate = clamp01(input.approvalRate);
  const avgDeductionRate = clamp01(input.avgDeductionRate);
  const asOfDay = toDateOnly(asOf);

  const pendingNow = pending.reduce((s, p) => s + p.amount, 0);

  // Bucket each pending payout onto the horizon day it matures.
  const pendingByDay = new Array<number>(horizonDays).fill(0);
  for (const p of pending) {
    const requested = toDateOnly(new Date(p.requestedAt));
    const maturity = new Date(requested.getTime() + PROCESSING_LAG_DAYS * DAY_MS);
    const offset = Math.floor((maturity.getTime() - asOfDay.getTime()) / DAY_MS);
    const day = Math.min(Math.max(offset, 0), horizonDays - 1);
    pendingByDay[day] += p.amount;
  }

  // Pipeline liability has no fixed maturity — spread evenly across the horizon.
  const pipelinePerDay = (fundedNearTargetCount * avgPipelinePayoutEstimate) / horizonDays;

  const p90ApprovalRate = Math.min(1, approvalRate + 0.1);
  const p90DeductionRate = Math.max(0, avgDeductionRate - 0.05);

  const points: ForecastPoint[] = [];
  let expectedP50 = 0;
  let expectedP90 = 0;

  for (let d = 0; d < horizonDays; d++) {
    const date = new Date(asOfDay.getTime() + d * DAY_MS);
    const grossPending = pendingByDay[d];
    const grossPipeline = pipelinePerDay;

    const pendingComponent = grossPending * approvalRate * (1 - avgDeductionRate);
    const pipelineComponent = grossPipeline * approvalRate * (1 - avgDeductionRate);
    const p50 = round2(pendingComponent + pipelineComponent);
    const p90 = round2((grossPending + grossPipeline) * p90ApprovalRate * (1 - p90DeductionRate));

    // Accumulate the rounded per-day values so the totals reconcile exactly
    // with the sum of the displayed points (no unrounded-vs-rounded drift).
    expectedP50 += p50;
    expectedP90 += p90;

    points.push({
      date: date.toISOString().slice(0, 10),
      p50,
      p90,
      pendingComponent: round2(pendingComponent),
      pipelineComponent: round2(pipelineComponent),
    });
  }

  return {
    asOf: asOf.toISOString(),
    horizonDays,
    points,
    totals: {
      pendingNow: round2(pendingNow),
      expectedP50: round2(expectedP50),
      expectedP90: round2(expectedP90),
    },
    assumptions: {
      approvalRate,
      avgDeductionRate,
      fundedNearTargetCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Historical rate derivation (shared by demo + would-be live path)
// ---------------------------------------------------------------------------

export function deriveHistoricalRates(decisions: MockPayoutDecision[]): {
  approvalRate: number;
  avgDeductionRate: number;
} {
  if (!decisions || decisions.length < MIN_HISTORY_SAMPLE) {
    return { approvalRate: DEFAULT_APPROVAL_RATE, avgDeductionRate: DEFAULT_DEDUCTION_RATE };
  }

  const approvals = decisions.filter((d) => d.decision === 'approve' || d.decision === 'preapprove').length;
  const approvalRate = approvals / decisions.length;

  const withProfit = decisions.filter((d) => d.rationale.math.grossProfit > 0);
  const avgDeductionRate =
    withProfit.length > 0
      ? withProfit.reduce((s, d) => s + d.rationale.math.totalDeductions / d.rationale.math.grossProfit, 0) /
        withProfit.length
      : DEFAULT_DEDUCTION_RATE;

  return { approvalRate: clamp01(approvalRate), avgDeductionRate: clamp01(avgDeductionRate) };
}

// ---------------------------------------------------------------------------
// Thin async wrapper — demo vs live input gathering
// ---------------------------------------------------------------------------

interface GatheredInputs {
  pending: ForecastPendingItem[];
  fundedNearTargetCount: number;
  avgPipelinePayoutEstimate: number;
  historicalApprovalRate: number;
  historicalDeductionRate: number;
}

function gatherDemoInputs(assetClass: AssetClass): GatheredInputs {
  const { allAccounts } = buildDashboard(assetClass);

  const pending: ForecastPendingItem[] = allAccounts.map((a) => ({
    amount: a.payoutAmount,
    requestedAt: a.payoutRequested,
  }));

  const fundedNearTargetCount = allAccounts.filter((a) => {
    if (a.startingBalance <= 0) return false;
    const profitRatio = a.totalPnL / a.startingBalance;
    return profitRatio >= PROFIT_TARGET_PCT * NEAR_TARGET_FLOOR_PCT && profitRatio < PROFIT_TARGET_PCT;
  }).length;

  const avgPipelinePayoutEstimate =
    pending.length > 0 ? pending.reduce((s, p) => s + p.amount, 0) / pending.length : 0;

  const { approvalRate, avgDeductionRate } = deriveHistoricalRates(MOCK_DECISION_HISTORY);

  return {
    pending,
    fundedNearTargetCount,
    avgPipelinePayoutEstimate,
    historicalApprovalRate: approvalRate,
    historicalDeductionRate: avgDeductionRate,
  };
}

async function gatherLiveInputs(tenantId: string): Promise<GatheredInputs> {
  try {
    const payouts = await fetchPendingPayouts({ statuses: ['Pending'], limit: 1000 }, tenantId);
    const pending: ForecastPendingItem[] = payouts.map((p) => ({
      amount: p.clientPayout ?? p.amount ?? 0,
      requestedAt: p.requested || new Date().toISOString(),
    }));
    const avgPipelinePayoutEstimate =
      pending.length > 0 ? pending.reduce((s, p) => s + p.amount, 0) / pending.length : 0;

    // Live pipeline detection needs startingBalance + totalPnL per account.
    // The adapter's monitored-accounts fallback (fetchAccountsToMonitor) only
    // exposes balance/totalPnL/plan for the no-payout-queue case, not
    // startingBalance — so the pipeline count degrades to 0 here rather than
    // fabricating a number. The pending queue is still useful on its own.
    // TODO: wire a real pipeline signal once a live adapter exposes
    // startingBalance on the monitored-accounts path.
    return {
      pending,
      fundedNearTargetCount: 0,
      avgPipelinePayoutEstimate,
      historicalApprovalRate: DEFAULT_APPROVAL_RATE,
      historicalDeductionRate: DEFAULT_DEDUCTION_RATE,
    };
  } catch {
    // No live provider configured — same "empty but valid" degrade used by
    // src/app/api/exposure/route.ts's live branch.
    return {
      pending: [],
      fundedNearTargetCount: 0,
      avgPipelinePayoutEstimate: 0,
      historicalApprovalRate: DEFAULT_APPROVAL_RATE,
      historicalDeductionRate: DEFAULT_DEDUCTION_RATE,
    };
  }
}

export interface ComputeLiabilityForecastParams {
  assetClass?: AssetClass;
  horizonDays?: 7 | 30;
  overrides?: Partial<ForecastAssumptions>;
  /**
   * Required for the live path (DEMO_MODE never reaches gatherLiveInputs, so
   * demo callers may pass '' — see src/app/api/forecast/liability/route.ts,
   * which skips auth entirely in demo mode and so has no tenant to give).
   */
  tenantId: string;
}

export async function computeLiabilityForecast(
  params: ComputeLiabilityForecastParams
): Promise<LiabilityForecast> {
  const assetClass: AssetClass = params.assetClass === 'futures' ? 'futures' : 'forex';
  const horizonDays: 7 | 30 = params.horizonDays === 30 ? 30 : 7;
  const asOf = new Date();

  const gathered = DEMO_MODE ? gatherDemoInputs(assetClass) : await gatherLiveInputs(params.tenantId);

  const approvalRate = params.overrides?.approvalRate ?? gathered.historicalApprovalRate;
  const avgDeductionRate = params.overrides?.avgDeductionRate ?? gathered.historicalDeductionRate;
  const fundedNearTargetCount = params.overrides?.fundedNearTargetCount ?? gathered.fundedNearTargetCount;

  return computeLiabilityForecastCore({
    asOf,
    horizonDays,
    pending: gathered.pending,
    fundedNearTargetCount,
    avgPipelinePayoutEstimate: gathered.avgPipelinePayoutEstimate,
    approvalRate,
    avgDeductionRate,
  });
}
