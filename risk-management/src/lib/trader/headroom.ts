import { computeDailyLossState } from '@/lib/rulepack/primitives/daily-loss';
import { computeDrawdownState } from '@/lib/rulepack/primitives/drawdown';
import type { RuleId, RulePack } from '@/lib/rulepack/schema';
import { groupBySessionDay } from '@/lib/rulepack/session';
import { describeThreshold, resolveThreshold, type EvaluationInput } from '@/lib/rulepack/types';

/**
 * Headroom — the trader-facing read of "where do I stand against my firm's
 * rules, right now."
 *
 * This is a PURE, read-only projection over the same rule pack + account
 * state the evaluator (`src/lib/rulepack/evaluate.ts`) breaches against. It
 * imports the evaluator's own primitives for the two rules where the running
 * state is genuinely load-bearing and easy to get subtly wrong — drawdown's
 * floor (three modes, an optional lock) and daily loss (three bases, one of
 * which needs intraday snapshots) — rather than re-deriving that arithmetic.
 * The vocabulary (thresholds, plain-language limits) is the same
 * `describeThreshold`/`resolveThreshold` the breach evidence uses, so this
 * view and a breach notice for the same account can never disagree about
 * what the rule says or where the account stood.
 *
 * Cross-account rules (grid, copy_trading) are never surfaced here, for the
 * same reason `evaluateRulePack` skips them per-account: they compare one
 * account against every other and would leak fraud-detection internals to
 * the person those internals are about. Purely episodic/behavioural rules
 * (news blackout, HFT, martingale) describe a WINDOW OF CONDUCT rather than a
 * running distance to a limit, so there is no "headroom" number to report for
 * them; they are omitted rather than shown with a fabricated position.
 */

const OMITTED_FROM_HEADROOM: ReadonlySet<RuleId> = new Set([
  'grid',
  'copy_trading',
  'news',
  'hft',
  'martingale',
]);

export type HeadroomStatus = 'ok' | 'breached' | 'unavailable';

export interface HeadroomItem {
  ruleId: RuleId;
  /** The limit, in the trader's own words — same vocabulary a breach notice uses. */
  limit: string;
  /** Where the account stands right now, in plain language. */
  position: string;
  /** e.g. "$340 from your daily loss limit". Empty when status is not "ok". */
  headroom: string;
  status: HeadroomStatus;
  /** Only present for the drawdown rule. */
  drawdown?: {
    floor: number;
    locked: boolean;
  };
  /** Machine-readable numbers behind `position`/`headroom`, for the UI to format. */
  values: Record<string, number | string | boolean | null>;
}

export interface HeadroomResult {
  accountId: string;
  items: HeadroomItem[];
  /** Rules that could not be evaluated, and why — same honesty convention as EvaluationResult.skipped. */
  skipped: Array<{ ruleId: RuleId; reason: string }>;
}

/**
 * Headroom for every ENABLED rule that applies to the account's current
 * phase, in the pack's own rule order.
 */
export function computeHeadroom(pack: RulePack, input: EvaluationInput): HeadroomResult {
  const items: HeadroomItem[] = [];
  const skipped: HeadroomResult['skipped'] = [];
  const { account } = input;

  const record = (ruleId: RuleId, result: HeadroomItem | { skipped: string }) => {
    if ('skipped' in result) skipped.push({ ruleId, reason: result.skipped });
    else items.push(result);
  };

  const rules = pack.rules;
  const ruleIds = Object.keys(rules) as RuleId[];

  for (const ruleId of ruleIds) {
    const rule = rules[ruleId];
    if (!rule || !rule.enabled) continue;
    if (!rule.applies_to_phases.includes(account.phase)) continue;
    if (OMITTED_FROM_HEADROOM.has(ruleId)) continue;

    switch (ruleId) {
      case 'daily_loss':
        record(ruleId, dailyLossHeadroom(rules.daily_loss!, pack.session, input));
        break;
      case 'drawdown':
        record(ruleId, drawdownHeadroom(rules.drawdown!, pack.session, input));
        break;
      case 'consistency':
        record(ruleId, consistencyHeadroom(rules.consistency!, pack.session, input));
        break;
      case 'min_trading_days':
        record(ruleId, minTradingDaysHeadroom(rules.min_trading_days!, pack.session, input));
        break;
      case 'position_limit':
        record(ruleId, positionLimitHeadroom(rules.position_limit!, input));
        break;
      case 'inactivity':
        record(ruleId, inactivityHeadroom(rules.inactivity!, input));
        break;
      case 'overnight_holding':
      case 'weekend_holding':
        record(ruleId, holdingWindowHeadroom(ruleId, rules[ruleId]!));
        break;
      default:
        // Exhaustively handled above; anything else falls through omitted.
        break;
    }
  }

  return { accountId: account.id, items, skipped };
}

function dailyLossHeadroom(
  rule: NonNullable<RulePack['rules']['daily_loss']>,
  session: RulePack['session'],
  input: EvaluationInput
): HeadroomItem | { skipped: string } {
  const state = computeDailyLossState(rule, session, input);
  if ('skipped' in state) return state;

  const { limit, loss } = state;
  const remaining = limit - loss;
  const breached = loss > limit;

  return {
    ruleId: 'daily_loss',
    limit: `Daily loss limit of ${describeThreshold(rule.threshold, input.account)}`,
    position: `You are down $${Math.max(loss, 0).toFixed(2)} today`,
    headroom: breached ? '' : `$${remaining.toFixed(2)} left before your daily loss limit`,
    status: breached ? 'breached' : 'ok',
    values: { limit, loss, remaining, sessionDay: state.sessionDay },
  };
}

function drawdownHeadroom(
  rule: NonNullable<RulePack['rules']['drawdown']>,
  session: RulePack['session'],
  input: EvaluationInput
): HeadroomItem | { skipped: string } {
  const state = computeDrawdownState(rule, session, input);
  if ('skipped' in state) return state;

  const { limit, peak, floor, locked, basis } = state;
  const current = basis === 'equity' ? input.account.currentEquity : input.account.currentBalance;
  const remaining = current - floor;
  const breached = current < floor;

  return {
    ruleId: 'drawdown',
    limit: `${state.label} of ${describeThreshold(rule.threshold, input.account)}`,
    position: `Your ${basis} floor is $${floor.toFixed(2)}${locked ? ' (locked — it will not move again)' : ''}`,
    headroom: breached ? '' : `$${remaining.toFixed(2)} above your drawdown floor`,
    status: breached ? 'breached' : 'ok',
    drawdown: { floor, locked },
    values: { limit, peak, floor, locked, current, remaining, basis },
  };
}

function consistencyHeadroom(
  rule: NonNullable<RulePack['rules']['consistency']>,
  session: RulePack['session'],
  input: EvaluationInput
): HeadroomItem | { skipped: string } {
  const closed = input.trades.filter((t) => !t.isOpen);
  const byDay = groupBySessionDay(closed, session, (t) => t.closeTime || t.openTime);

  const dailyProfits = [...byDay.values()]
    .map((ts) => ts.reduce((s, t) => s + t.profit, 0))
    .filter((p) => p > 0);
  const totalProfit = dailyProfits.reduce((s, p) => s + p, 0);

  if (totalProfit <= rule.min_profit_to_evaluate) {
    return {
      skipped: `total profit $${totalProfit.toFixed(2)} is at or below the $${rule.min_profit_to_evaluate.toFixed(2)} floor for evaluating consistency`,
    };
  }

  const bestDayProfit = Math.max(...dailyProfits);
  const share = bestDayProfit / totalProfit;
  const breached = share > rule.max_best_day_pct_of_profit;

  return {
    ruleId: 'consistency',
    limit: `No single day may account for more than ${(rule.max_best_day_pct_of_profit * 100).toFixed(0)}% of your total profit`,
    position: `Your best day is ${(share * 100).toFixed(1)}% of your total profit so far`,
    headroom: breached
      ? ''
      : `${((rule.max_best_day_pct_of_profit - share) * 100).toFixed(1)} percentage points of headroom`,
    status: breached ? 'breached' : 'ok',
    values: { limit: rule.max_best_day_pct_of_profit, share, bestDayProfit, totalProfit },
  };
}

function minTradingDaysHeadroom(
  rule: NonNullable<RulePack['rules']['min_trading_days']>,
  session: RulePack['session'],
  input: EvaluationInput
): HeadroomItem {
  const byDay = groupBySessionDay(
    input.trades.filter((t) => !t.isOpen),
    session,
    (t) => t.closeTime || t.openTime
  );

  const qualifying = [...byDay.values()].filter((ts) =>
    rule.count_basis === 'profitable' ? ts.reduce((s, t) => s + t.profit, 0) > 0 : true
  ).length;

  const label = rule.count_basis === 'profitable' ? 'profitable trading days' : 'trading days';
  const met = qualifying >= rule.min_days;

  return {
    ruleId: 'min_trading_days',
    limit: `At least ${rule.min_days} ${label} required`,
    position: `You have ${qualifying} of ${rule.min_days} required ${label}`,
    headroom: met ? 'Requirement met' : `${rule.min_days - qualifying} more ${label} needed`,
    status: 'ok',
    values: { required: rule.min_days, actual: qualifying, met },
  };
}

function positionLimitHeadroom(
  rule: NonNullable<RulePack['rules']['position_limit']>,
  input: EvaluationInput
): HeadroomItem | { skipped: string } {
  let limit: number | undefined;
  if (rule.mode === 'fixed') {
    limit = rule.fixed_limit;
  } else {
    limit = rule.limits_by_size?.[String(input.account.startingBalance)];
  }

  if (limit === undefined) {
    return {
      skipped: `no position limit configured for a $${input.account.startingBalance} account`,
    };
  }

  const openSize = input.trades.filter((t) => t.isOpen).reduce((s, t) => s + t.size, 0);

  return {
    ruleId: 'position_limit',
    limit: `Maximum ${limit} contracts/lots open at once`,
    position: `You currently have ${openSize} open`,
    headroom: `${Math.max(limit - openSize, 0)} remaining`,
    status: openSize > limit ? 'breached' : 'ok',
    values: { limit, openSize },
  };
}

function inactivityHeadroom(
  rule: NonNullable<RulePack['rules']['inactivity']>,
  input: EvaluationInput
): HeadroomItem | { skipped: string } {
  if (input.trades.length === 0) {
    return { skipped: 'no trades on record, so there is no last-activity date to measure from' };
  }

  const last = Math.max(
    ...input.trades
      .map((t) => Date.parse(t.closeTime || t.openTime))
      .filter((n) => !Number.isNaN(n))
  );
  const idleDays = Math.floor((Date.parse(input.now) - last) / 86_400_000);
  const remaining = rule.max_idle_days - idleDays;

  return {
    ruleId: 'inactivity',
    limit: `No more than ${rule.max_idle_days} consecutive days without trading`,
    position: `${idleDays} day(s) since your last trade`,
    headroom: remaining > 0 ? `${remaining} day(s) before you must trade again` : '',
    status: idleDays > rule.max_idle_days ? 'breached' : 'ok',
    values: { maxIdleDays: rule.max_idle_days, idleDays },
  };
}

function holdingWindowHeadroom(
  ruleId: 'overnight_holding' | 'weekend_holding',
  rule: { flat_by: string }
): HeadroomItem {
  const label = ruleId === 'overnight_holding' ? 'overnight' : 'over the weekend';
  return {
    ruleId,
    limit: `Positions must be closed by ${rule.flat_by} to avoid holding ${label}`,
    position: `Flat-by time is ${rule.flat_by}`,
    headroom: '',
    status: 'ok',
    values: { flatBy: rule.flat_by },
  };
}

// Re-exported so callers building EvaluationInput never need to reach past
// this module into the primitives directly.
export { resolveThreshold, describeThreshold };
