/**
 * Liability forecasting shared types.
 *
 * A `LiabilityForecast` projects the firm's expected payout liability over a
 * horizon: pending payouts already in the queue plus the modeled pipeline
 * (accounts approaching a fundable/near-target state), expressed as p50/p90
 * bands per day.
 */

export interface ForecastPoint {
  /** ISO date (YYYY-MM-DD) for this point on the horizon. */
  date: string;
  p50: number;
  p90: number;
  /** Portion of p50 attributable to already-pending payouts. */
  pendingComponent: number;
  /** Portion of p50 attributable to the modeled future pipeline. */
  pipelineComponent: number;
}

export interface ForecastAssumptions {
  /** Historical/assumed approval rate (0..1) applied to pending + pipeline payouts. */
  approvalRate: number;
  /** Average deduction rate (0..1) applied against gross payout amounts. */
  avgDeductionRate: number;
  /** Count of funded accounts trending toward a payout-eligible target. */
  fundedNearTargetCount: number;
}

export interface LiabilityForecast {
  /** ISO datetime the forecast was generated as-of. */
  asOf: string;
  horizonDays: number;
  points: ForecastPoint[];
  totals: {
    pendingNow: number;
    expectedP50: number;
    expectedP90: number;
  };
  assumptions: ForecastAssumptions;
}
