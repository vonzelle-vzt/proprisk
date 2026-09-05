import { createHash } from 'crypto';
import type { SessionConfig, dailyLossSchema } from '../schema';
import type { z } from 'zod';
import { groupBySessionDay, sessionDayKey } from '../session';
import {
  describeThreshold,
  resolveThreshold,
  type BreachDecision,
  type EquitySnapshot,
  type EvaluationInput,
  type TradeInput,
} from '../types';

type DailyLossRule = z.infer<typeof dailyLossSchema>;

/**
 * Daily loss.
 *
 * The variance between firms lives entirely in `basis`:
 *
 *  - `balance`  — realised PnL only, measured from the day's opening balance.
 *    FTMO's model: an open losing position does not breach until it is closed.
 *
 *  - `equity`   — realised plus unrealised, measured from the day's opening
 *    equity. An open drawdown breaches immediately.
 *
 *  - `highest_equity_of_day` — measured from the intraday high-water mark
 *    rather than the open. The harshest basis: an account that runs +$2,000
 *    then falls to −$100 has lost $2,100 by this measure, not $100.
 *
 * The last one cannot be computed from closed trades alone, because the peak
 * often occurs while a position is open and never appears in the trade tape.
 * Without snapshots the rule reports `indeterminate` rather than silently
 * falling back to a laxer basis — quietly answering a different question than
 * the firm configured is how a platform loses a dispute.
 */
export function evaluateDailyLoss(
  rule: DailyLossRule,
  session: SessionConfig,
  input: EvaluationInput,
  packVersion: string
): { decisions: BreachDecision[]; skipped?: string } {
  const { account, trades, snapshots } = input;
  const limit = resolveThreshold(rule.threshold, account);

  if (rule.basis === 'highest_equity_of_day' && (!snapshots || snapshots.length === 0)) {
    return {
      decisions: [],
      skipped:
        'basis "highest_equity_of_day" needs intraday equity snapshots; none were supplied, and the peak cannot be recovered from closed trades because it usually occurs while a position is open.',
    };
  }

  const countable = rule.include_open_pnl ? trades : trades.filter((t) => !t.isOpen);
  const byDay = groupBySessionDay(countable, session, (t) => t.closeTime || t.openTime);
  const snapshotsByDay = snapshots
    ? groupBySessionDay(snapshots, session, (s) => s.at)
    : new Map<string, never[]>();

  const decisions: BreachDecision[] = [];

  for (const [day, dayTrades] of byDay) {
    const daySnaps = snapshotsByDay.get(day) ?? [];
    const computed = lossForDay(rule, dayTrades, daySnaps, limit);
    if (!computed) continue;
    const { loss, math } = computed;

    if (loss <= limit) continue;

    decisions.push({
      ruleId: 'daily_loss',
      accountId: account.id,
      action: rule.action,
      exceededBy: loss - limit,
      evidence: {
        limit: `Daily loss limit of ${describeThreshold(rule.threshold, account)}, measured on ${rule.basis.replace(/_/g, ' ')}`,
        observed: `$${loss.toFixed(2)} lost on the ${day} session`,
        math,
        tradeIds: dayTrades.map((t) => t.id),
        sessionDay: day,
        values: {
          limit,
          loss,
          exceededBy: loss - limit,
          basis: rule.basis,
          tradeCount: dayTrades.length,
        },
      },
      idempotencyKey: dailyLossKey(packVersion, account.id, day, loss, limit),
    });
  }

  return { decisions };
}

/**
 * Identity of a daily-loss decision. Keyed on the pack version, the account,
 * the session day and the measured numbers — so re-running the same job is a
 * no-op, while a genuinely different outcome (a corrected trade tape, a new
 * pack version) is a genuinely different decision.
 *
 * This replaces the previous wall-clock dedup, which suppressed a second
 * detection for an hour regardless of whether anything had changed and so gave
 * different answers depending on when the cron happened to fire.
 */
function dailyLossKey(
  packVersion: string,
  accountId: string,
  day: string,
  loss: number,
  limit: number
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        rule: 'daily_loss',
        packVersion,
        accountId,
        day,
        loss: loss.toFixed(2),
        limit: limit.toFixed(2),
      })
    )
    .digest('hex')
    .slice(0, 32);
}

/**
 * The measured loss for one session day, and the arithmetic behind it. Shared
 * by `evaluateDailyLoss` (which checks it against the limit) and
 * `computeDailyLossState` (which reports it regardless of whether it has
 * breached), so the two can never describe today's loss differently.
 *
 * Returns null only for `highest_equity_of_day` with no snapshots for that
 * day — the caller decides what "can't tell yet" means for its own shape.
 */
function lossForDay(
  rule: DailyLossRule,
  dayTrades: TradeInput[],
  daySnaps: EquitySnapshot[],
  limit: number
): { loss: number; math: string } | null {
  if (rule.basis === 'highest_equity_of_day') {
    if (daySnaps.length === 0) return null;

    const peak = Math.max(...daySnaps.map((s) => s.equity));
    const trough = Math.min(...daySnaps.map((s) => s.equity));
    const loss = peak - trough;
    return {
      loss,
      math:
        `peak equity $${peak.toFixed(2)} − lowest equity $${trough.toFixed(2)} = $${loss.toFixed(2)} ` +
        `drawn down against a $${limit.toFixed(2)} limit`,
    };
  }

  // Both `balance` and `equity` measure from the day's open; they differ in
  // whether open positions are already counted, which is decided by whatever
  // filtered `dayTrades` before it reached here (`include_open_pnl`).
  const realised = dayTrades.reduce((sum, t) => sum + t.profit, 0);
  const loss = -realised;
  return {
    loss,
    math:
      `net ${rule.basis} change $${realised.toFixed(2)} across ${dayTrades.length} trade(s) ` +
      `= $${loss.toFixed(2)} lost against a $${limit.toFixed(2)} limit`,
  };
}

export interface DailyLossState {
  limit: number;
  loss: number;
  basis: DailyLossRule['basis'];
  sessionDay: string;
}

/**
 * Today's loss to date, for a trader-facing headroom view — not whether it
 * has breached, just where the account currently stands against the limit.
 * Returns null where the engine itself could not tell (no snapshots yet today
 * for `highest_equity_of_day`), matching the "indeterminate, not a guess"
 * convention `evaluateDailyLoss` follows.
 */
export function computeDailyLossState(
  rule: DailyLossRule,
  session: SessionConfig,
  input: EvaluationInput
): DailyLossState | { skipped: string } {
  const { account, trades, snapshots, now } = input;
  const limit = resolveThreshold(rule.threshold, account);

  if (rule.basis === 'highest_equity_of_day' && (!snapshots || snapshots.length === 0)) {
    return {
      skipped:
        'basis "highest_equity_of_day" needs intraday equity snapshots; none were supplied, and the peak cannot be recovered from closed trades because it usually occurs while a position is open.',
    };
  }

  const today = sessionDayKey(now, session);
  const countable = rule.include_open_pnl ? trades : trades.filter((t) => !t.isOpen);
  const dayTrades = countable.filter(
    (t) => sessionDayKey(t.closeTime || t.openTime, session) === today
  );
  const daySnaps = (snapshots ?? []).filter((s) => sessionDayKey(s.at, session) === today);

  const computed = lossForDay(rule, dayTrades, daySnaps, limit);
  if (!computed) {
    return {
      skipped:
        'basis "highest_equity_of_day" has no snapshots yet for today\'s session; the peak cannot be recovered from closed trades alone.',
    };
  }

  return { limit, loss: computed.loss, basis: rule.basis, sessionDay: today };
}

export { sessionDayKey };
