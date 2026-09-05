import { createHash } from 'crypto';
import type { z } from 'zod';
import type { SessionConfig, drawdownSchema } from '../schema';
import { sessionDayKey } from '../session';
import {
  describeThreshold,
  resolveThreshold,
  type BreachDecision,
  type EvaluationInput,
  type TradeInput,
} from '../types';

type DrawdownRule = z.infer<typeof drawdownSchema>;

/**
 * Drawdown — the primitive the whole futures market differs on.
 *
 * A drawdown rule is a FLOOR that the account must stay above. Firms differ in
 * two independent ways: how the floor moves, and whether it ever stops moving.
 *
 *   mode = static             floor fixed at open, never moves.
 *                             FTMO, FundedNext: $100k account, 10% → $90,000
 *                             for the whole challenge however well it does.
 *
 *   mode = trailing_intraday  floor follows every new equity high, tick by tick.
 *                             Apex. Run to +$2,000 intraday and give it back and
 *                             the floor has already ratcheted up — this is why
 *                             it is the harshest model in the market.
 *
 *   mode = trailing_eod       floor follows the END-OF-DAY equity only.
 *                             TopStep, Tradeify. An intraday spike does not
 *                             move it, so a good day that round-trips costs
 *                             nothing.
 *
 *   lock = at_initial_balance the floor stops trailing once it reaches the
 *                             STARTING BALANCE and never moves again. This is
 *                             what makes a funded account progressively safer;
 *                             without it a profitable account is never further
 *                             from breach than a brand new one. TopStep's model.
 *
 * The engine this replaces implemented one behaviour — peak-to-trough over
 * closed trades — and compared the worst historical excursion to the limit.
 * That is none of the three above: it ignored the lock entirely, could not see
 * intraday peaks, and reported a breach at whatever moment the maximum
 * excursion happened rather than at the moment the floor was actually crossed.
 */
export function evaluateDrawdown(
  rule: DrawdownRule,
  session: SessionConfig,
  input: EvaluationInput,
  packVersion: string
): { decisions: BreachDecision[]; skipped?: string } {
  const walk = walkDrawdown(rule, session, input);
  if ('skipped' in walk) return { decisions: [], skipped: walk.skipped };

  const { account } = input;
  const { limit, breach } = walk;
  if (!breach) return { decisions: [] };

  const { point, peak, floor, locked } = breach;
  const shortfall = floor - point.value;

  return {
    decisions: [
      {
        ruleId: 'drawdown',
        accountId: account.id,
        action: rule.action,
        exceededBy: shortfall,
        evidence: {
          limit:
            `${describeLabel(rule)} of ${describeThreshold(rule.threshold, account)} — ` +
            `floor at $${floor.toFixed(2)}${locked ? ' (locked)' : ''}`,
          observed: `${rule.basis} fell to $${point.value.toFixed(2)} on ${point.day}`,
          math:
            `peak ${rule.basis} $${peak.toFixed(2)} − limit $${limit.toFixed(2)} = floor $${floor.toFixed(2)}; ` +
            `${rule.basis} $${point.value.toFixed(2)} is $${shortfall.toFixed(2)} below it`,
          tradeIds: point.tradeId ? [point.tradeId] : [],
          sessionDay: point.day,
          values: {
            limit,
            peak,
            floor,
            value: point.value,
            exceededBy: shortfall,
            mode: rule.mode,
            lock: rule.lock,
            locked: locked ? 'true' : 'false',
          },
        },
        // Breach at the FIRST crossing, not the worst excursion: the account
        // is dead at that moment and everything after it is a consequence,
        // not a second offence.
        idempotencyKey: drawdownKey(packVersion, account.id, point, floor),
      },
    ],
  };
}

interface SeriesPoint {
  at: string;
  day: string;
  value: number;
  tradeId?: string;
}

/**
 * Current floor state, for a trader-facing headroom view. Read-only: it walks
 * the exact same series/peak/lock logic `evaluateDrawdown` breaches against,
 * so the two can never disagree about where the floor sits or whether it has
 * locked. Deliberately NOT re-derived independently — see the module doc on
 * why the floor is the number a dispute turns on.
 */
export interface DrawdownState {
  limit: number;
  peak: number;
  floor: number;
  locked: boolean;
  basis: 'balance' | 'equity';
  label: string;
}

export function computeDrawdownState(
  rule: DrawdownRule,
  session: SessionConfig,
  input: EvaluationInput
): DrawdownState | { skipped: string } {
  const walk = walkDrawdown(rule, session, input);
  if ('skipped' in walk) return { skipped: walk.skipped };

  // If the series already breached (should not happen for a live account,
  // since a breach ends the challenge, but the walk stops at first crossing
  // rather than assuming that), report the floor as of that crossing — the
  // most recent floor the account is a real fact about, not a later one it
  // never reached.
  const state = walk.breach
    ? { peak: walk.breach.peak, floor: walk.breach.floor, locked: walk.breach.locked }
    : { peak: walk.finalPeak, floor: walk.finalFloor, locked: walk.finalLocked };

  return {
    limit: walk.limit,
    peak: state.peak,
    floor: state.floor,
    locked: state.locked,
    basis: rule.basis,
    label: describeLabel(rule),
  };
}

interface DrawdownWalkResult {
  limit: number;
  finalPeak: number;
  finalFloor: number;
  finalLocked: boolean;
  breach: { point: SeriesPoint; peak: number; floor: number; locked: boolean } | null;
}

/**
 * The single walk both `evaluateDrawdown` and `computeDrawdownState` run.
 * Kept private and shared rather than duplicated in each caller, because the
 * peak/floor/lock arithmetic is exactly what a trader dispute turns on.
 */
function walkDrawdown(
  rule: DrawdownRule,
  session: SessionConfig,
  input: EvaluationInput
): DrawdownWalkResult | { skipped: string } {
  const { account, trades, snapshots } = input;
  const limit = resolveThreshold(rule.threshold, account);

  if (rule.mode === 'trailing_intraday' && (!snapshots || snapshots.length === 0)) {
    return {
      skipped:
        'mode "trailing_intraday" needs intraday equity snapshots: the floor moves on ticks that never appear in the closed-trade tape, so evaluating without them would silently apply the laxer end-of-day model.',
    };
  }

  const series = buildSeries(rule, session, trades, snapshots, account.startingBalance);
  if (series.length === 0) {
    return { skipped: 'no trades or snapshots to evaluate' };
  }

  // The floor starts `limit` below the opening balance and rises with the peak,
  // subject to the lock ceiling.
  const lockCeiling = lockCeilingFor(rule, account.startingBalance);
  let peak = account.startingBalance;
  let floor = account.startingBalance - limit;
  let locked = false;

  for (const point of series) {
    if (!locked && point.value > peak) {
      peak = point.value;
      const candidate = peak - limit;

      if (lockCeiling !== null && candidate >= lockCeiling) {
        // The floor reaches its ceiling and stops here, permanently.
        floor = lockCeiling;
        locked = true;
      } else if (rule.mode !== 'static') {
        floor = candidate;
      }
    }

    if (point.value >= floor) continue;

    return {
      limit,
      finalPeak: peak,
      finalFloor: floor,
      finalLocked: locked,
      breach: { point, peak, floor, locked },
    };
  }

  return { limit, finalPeak: peak, finalFloor: floor, finalLocked: locked, breach: null };
}

/**
 * The series the floor is walked against.
 *
 * `trailing_intraday` needs every snapshot. `trailing_eod` needs one value per
 * session day — the day's CLOSE, which is what "end of day" means; using the
 * day's peak here would quietly reproduce the intraday model. `static` never
 * moves the floor, so any ordered series of values suffices.
 */
function buildSeries(
  rule: DrawdownRule,
  session: SessionConfig,
  trades: TradeInput[],
  snapshots: EvaluationInput['snapshots'],
  startingBalance: number
): SeriesPoint[] {
  const pick = (s: { balance: number; equity: number }) =>
    rule.basis === 'equity' ? s.equity : s.balance;

  if (rule.mode === 'trailing_intraday' && snapshots?.length) {
    return [...snapshots]
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .map((s) => ({ at: s.at, day: sessionDayKey(s.at, session), value: pick(s) }));
  }

  if (rule.mode === 'trailing_eod' && snapshots?.length) {
    const lastOfDay = new Map<string, SeriesPoint>();
    for (const s of [...snapshots].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
      const day = sessionDayKey(s.at, session);
      lastOfDay.set(day, { at: s.at, day, value: pick(s) });
    }
    return [...lastOfDay.values()];
  }

  // Fall back to a running balance rebuilt from closed trades. Exact for the
  // `balance` basis; for `equity` it is the closed-trade approximation, which
  // is why the intraday mode refuses to run without snapshots above.
  const closed = trades
    .filter((t) => !t.isOpen)
    .sort(
      (a, b) =>
        Date.parse(a.closeTime || a.openTime) - Date.parse(b.closeTime || b.openTime)
    );

  // The series must be an equity/balance LEVEL, not cumulative PnL: the floor
  // it is compared against is an absolute account value. Starting the running
  // total at zero would put every account below its floor from the first trade.
  let running = startingBalance;
  return closed.map((t) => {
    running += t.profit;
    const at = t.closeTime || t.openTime;
    return { at, day: sessionDayKey(at, session), value: running, tradeId: t.id };
  });
}

/**
 * The highest the floor may ever reach.
 *
 * `at_initial_balance` is the common case: the floor climbs until it equals the
 * account's opening balance, then freezes — so a funded trader can never be
 * stopped out above their starting capital.
 */
function lockCeilingFor(rule: DrawdownRule, startingBalance: number): number | null {
  switch (rule.lock) {
    case 'never':
      return null;
    case 'at_initial_balance':
      return startingBalance;
    case 'at_initial_plus':
      return startingBalance + (rule.lock_buffer ?? 0);
  }
}

function describeLabel(rule: DrawdownRule): string {
  switch (rule.mode) {
    case 'static':
      return 'Static maximum drawdown';
    case 'trailing_intraday':
      return 'Trailing (intraday) maximum drawdown';
    case 'trailing_eod':
      return 'Trailing (end-of-day) maximum drawdown';
  }
}

function drawdownKey(
  packVersion: string,
  accountId: string,
  point: SeriesPoint,
  floor: number
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        rule: 'drawdown',
        packVersion,
        accountId,
        at: point.at,
        value: point.value.toFixed(2),
        floor: floor.toFixed(2),
      })
    )
    .digest('hex')
    .slice(0, 32);
}
