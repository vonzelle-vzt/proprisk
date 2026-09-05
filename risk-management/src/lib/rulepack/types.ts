import type { AccountPhase, BreachAction, RuleId, Threshold } from './schema';

/**
 * Evaluation inputs and outputs.
 *
 * Everything here is plain data. The evaluator is a pure function over it, which
 * is what makes shadow mode free: replaying 90 days of history is the same call
 * with `enforce: false`, not a second implementation that can drift from the
 * live one.
 */

/** The account under evaluation, normalised across providers. */
export interface AccountContext {
  id: string;
  login: string;
  phase: AccountPhase;
  /** Balance the account opened with. The denominator for pct_of_initial. */
  startingBalance: number;
  currentBalance: number;
  currentEquity: number;
  /** Deposits/withdrawals since inception; excluded from performance maths. */
  netTransfers?: number;
}

/** One closed or open trade. */
export interface TradeInput {
  id: string;
  symbol: string;
  /** Instrument class for per-symbol-class limits, e.g. 'forex' | 'crypto'. */
  symbolClass?: string;
  openTime: string;
  closeTime?: string | null;
  /** Realised PnL for closed trades; unrealised for open ones. */
  profit: number;
  /** Size in the platform's native unit (lots for forex, contracts for futures). */
  size: number;
  isOpen?: boolean;
}

/**
 * A point-in-time balance/equity observation. Trailing-intraday drawdown and
 * highest-equity-of-day cannot be reconstructed from closed trades alone — the
 * peak may occur while a position is open and never appear in the trade tape.
 * Where snapshots are unavailable the evaluator says so rather than guessing.
 */
export interface EquitySnapshot {
  at: string;
  balance: number;
  equity: number;
}

export interface EvaluationInput {
  account: AccountContext;
  trades: TradeInput[];
  snapshots?: EquitySnapshot[];
  /** Economic calendar events, for the news rule. */
  newsEvents?: Array<{ at: string; impact: 'red' | 'orange' | 'yellow'; currency: string }>;
  /** Evaluation instant; injected so results are reproducible on replay. */
  now: string;
}

/**
 * Why a rule fired, in numbers. This is what the trader-facing notice and the
 * dispute evidence pack are built from, so it has to stand on its own months
 * later without the code that produced it.
 */
export interface BreachEvidence {
  /** Human-readable statement of the limit that was set. */
  limit: string;
  /** What the account actually did. */
  observed: string;
  /** The arithmetic, spelled out. */
  math: string;
  /** Trades that caused or contributed to the breach. */
  tradeIds: string[];
  /** Session day the breach belongs to, where the rule is day-scoped. */
  sessionDay?: string;
  /** Machine-readable inputs, for reconciliation and replay. */
  values: Record<string, number | string | null>;
}

export interface BreachDecision {
  ruleId: RuleId;
  accountId: string;
  action: BreachAction;
  /** Currency amount over the limit, where the rule has one. */
  exceededBy: number | null;
  evidence: BreachEvidence;
  /**
   * Stable identity of this decision: the same inputs against the same pack
   * version must produce the same key. Replaces wall-clock dedup windows, which
   * give different answers depending on when the job happened to run.
   */
  idempotencyKey: string;
  /** Rules the engine could not evaluate keep `indeterminate` rather than pass. */
  indeterminate?: { reason: string };
}

export interface EvaluationResult {
  accountId: string;
  decisions: BreachDecision[];
  /**
   * Rules that were skipped, and why. A firm reading a backtest needs to tell
   * "no breach" apart from "not checked" — silently returning nothing for a
   * rule whose data was missing is how a platform loses a dispute.
   */
  skipped: Array<{ ruleId: RuleId; reason: string }>;
}

/** Resolve a threshold to an absolute currency amount for one account. */
export function resolveThreshold(threshold: Threshold, account: AccountContext): number {
  switch (threshold.type) {
    case 'fixed':
      return threshold.value;
    case 'pct_of_initial':
      return account.startingBalance * threshold.value;
    case 'pct_of_current':
      return account.currentBalance * threshold.value;
  }
}

/** Describe a threshold the way a trader disputing it would need to read it. */
export function describeThreshold(threshold: Threshold, account: AccountContext): string {
  const amount = resolveThreshold(threshold, account);
  switch (threshold.type) {
    case 'fixed':
      return `$${amount.toFixed(2)}`;
    case 'pct_of_initial':
      return `$${amount.toFixed(2)} (${(threshold.value * 100).toFixed(2)}% of the $${account.startingBalance.toFixed(2)} starting balance)`;
    case 'pct_of_current':
      return `$${amount.toFixed(2)} (${(threshold.value * 100).toFixed(2)}% of the $${account.currentBalance.toFixed(2)} current balance)`;
  }
}
