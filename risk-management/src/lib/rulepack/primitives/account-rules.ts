import { createHash } from 'crypto';
import type { z } from 'zod';
import type {
  SessionConfig,
  consistencySchema,
  holdingWindowSchema,
  inactivitySchema,
  minTradingDaysSchema,
  positionLimitSchema,
} from '../schema';
import { groupBySessionDay, isAtOrAfterLocalTime, sessionWeekday } from '../session';
import type { BreachDecision, EvaluationInput } from '../types';

function key(parts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/**
 * Consistency — no single day may account for more than N% of total profit.
 *
 * Almost always evaluated at payout rather than continuously, because on any
 * given day early in an account's life one day IS 100% of the profit so far.
 * The schema refuses `continuous` without a `min_profit_to_evaluate` floor for
 * exactly that reason.
 */
export function evaluateConsistency(
  rule: z.infer<typeof consistencySchema>,
  session: SessionConfig,
  input: EvaluationInput,
  packVersion: string
): { decisions: BreachDecision[]; skipped?: string } {
  const { account, trades } = input;
  const closed = trades.filter((t) => !t.isOpen);
  const byDay = groupBySessionDay(closed, session, (t) => t.closeTime || t.openTime);

  // Only profitable days count toward the denominator: a firm caps the share of
  // WINNINGS one day contributed, and netting losing days in would let a big
  // loss elsewhere disguise a single outsized win.
  const dailyProfits = [...byDay.entries()]
    .map(([day, ts]) => ({ day, profit: ts.reduce((s, t) => s + t.profit, 0), ts }))
    .filter((d) => d.profit > 0);

  const totalProfit = dailyProfits.reduce((s, d) => s + d.profit, 0);
  if (totalProfit <= rule.min_profit_to_evaluate) {
    return {
      decisions: [],
      skipped: `total profit $${totalProfit.toFixed(2)} is at or below the $${rule.min_profit_to_evaluate.toFixed(2)} floor for evaluating consistency`,
    };
  }

  const best = dailyProfits.reduce((m, d) => (d.profit > m.profit ? d : m), dailyProfits[0]);
  const share = best.profit / totalProfit;
  if (share <= rule.max_best_day_pct_of_profit) return { decisions: [] };

  return {
    decisions: [
      {
        ruleId: 'consistency',
        accountId: account.id,
        action: rule.action,
        exceededBy: null,
        evidence: {
          limit: `No single day may exceed ${(rule.max_best_day_pct_of_profit * 100).toFixed(1)}% of total profit`,
          observed: `${best.day} contributed ${(share * 100).toFixed(1)}% of total profit`,
          math: `best day $${best.profit.toFixed(2)} ÷ total profit $${totalProfit.toFixed(2)} = ${(share * 100).toFixed(1)}%`,
          tradeIds: best.ts.map((t) => t.id),
          sessionDay: best.day,
          values: {
            bestDayProfit: best.profit,
            totalProfit,
            share,
            limit: rule.max_best_day_pct_of_profit,
          },
        },
        idempotencyKey: key({
          rule: 'consistency',
          packVersion,
          accountId: account.id,
          day: best.day,
          share: share.toFixed(4),
        }),
      },
    ],
  };
}

/** Minimum trading days, counted as any day traded or only profitable days. */
export function evaluateMinTradingDays(
  rule: z.infer<typeof minTradingDaysSchema>,
  session: SessionConfig,
  input: EvaluationInput,
  packVersion: string
): { decisions: BreachDecision[] } {
  const { account, trades } = input;
  const byDay = groupBySessionDay(
    trades.filter((t) => !t.isOpen),
    session,
    (t) => t.closeTime || t.openTime
  );

  const qualifying = [...byDay.entries()].filter(([, ts]) =>
    rule.count_basis === 'profitable' ? ts.reduce((s, t) => s + t.profit, 0) > 0 : true
  );

  if (qualifying.length >= rule.min_days) return { decisions: [] };

  const label = rule.count_basis === 'profitable' ? 'profitable trading days' : 'trading days';
  return {
    decisions: [
      {
        ruleId: 'min_trading_days',
        accountId: account.id,
        action: rule.action,
        exceededBy: null,
        evidence: {
          limit: `At least ${rule.min_days} ${label} required`,
          observed: `${qualifying.length} ${label} recorded`,
          math: `${qualifying.length} of ${rule.min_days} required ${label}`,
          tradeIds: [],
          values: { required: rule.min_days, actual: qualifying.length, basis: rule.count_basis },
        },
        idempotencyKey: key({
          rule: 'min_trading_days',
          packVersion,
          accountId: account.id,
          actual: qualifying.length,
        }),
      },
    ],
  };
}

/** Account dormant for longer than the firm permits. */
export function evaluateInactivity(
  rule: z.infer<typeof inactivitySchema>,
  input: EvaluationInput,
  packVersion: string
): { decisions: BreachDecision[]; skipped?: string } {
  const { account, trades, now } = input;
  if (trades.length === 0) {
    return { decisions: [], skipped: 'no trades on record, so there is no last-activity date to measure from' };
  }

  const last = Math.max(
    ...trades.map((t) => Date.parse(t.closeTime || t.openTime)).filter((n) => !Number.isNaN(n))
  );
  const idleDays = Math.floor((Date.parse(now) - last) / 86_400_000);
  if (idleDays <= rule.max_idle_days) return { decisions: [] };

  return {
    decisions: [
      {
        ruleId: 'inactivity',
        accountId: account.id,
        action: rule.action,
        exceededBy: null,
        evidence: {
          limit: `No more than ${rule.max_idle_days} consecutive days without trading`,
          observed: `${idleDays} days since the last trade`,
          math: `last trade ${new Date(last).toISOString().slice(0, 10)}, evaluated ${now.slice(0, 10)} = ${idleDays} idle days`,
          tradeIds: [],
          values: { maxIdleDays: rule.max_idle_days, idleDays },
        },
        idempotencyKey: key({
          rule: 'inactivity',
          packVersion,
          accountId: account.id,
          idleDays,
        }),
      },
    ],
  };
}

/**
 * Position size ceiling.
 *
 * `by_account_size` looks the limit up from the account's starting balance. The
 * engine this replaces fell back to a hardcoded `|| 10` contracts for any size
 * outside a four-entry map, so an unlisted account was policed against a number
 * nobody had chosen. Here an unlisted size is `indeterminate` — the pack author
 * is told their table has a gap instead of a default being invented for them.
 */
export function evaluatePositionLimit(
  rule: z.infer<typeof positionLimitSchema>,
  input: EvaluationInput,
  packVersion: string
): { decisions: BreachDecision[]; skipped?: string } {
  const { account, trades } = input;

  let limit: number | undefined;
  if (rule.mode === 'fixed') {
    limit = rule.fixed_limit;
  } else {
    limit = rule.limits_by_size?.[String(account.startingBalance)];
    if (limit === undefined) {
      return {
        decisions: [],
        skipped: `no position limit configured for a $${account.startingBalance} account; add it to position_limit.limits_by_size rather than relying on a default`,
      };
    }
  }
  if (limit === undefined) return { decisions: [], skipped: 'position limit not configured' };

  const decisions: BreachDecision[] = [];
  for (const trade of trades) {
    const effective = rule.per_symbol_class?.[trade.symbolClass ?? ''] ?? limit;
    if (trade.size <= effective) continue;

    decisions.push({
      ruleId: 'position_limit',
      accountId: account.id,
      action: rule.action,
      exceededBy: trade.size - effective,
      evidence: {
        limit: `Maximum position of ${effective} on ${trade.symbolClass ?? 'any instrument'}`,
        observed: `${trade.size} on ${trade.symbol}`,
        math: `${trade.size} − ${effective} = ${(trade.size - effective).toFixed(2)} over the limit`,
        tradeIds: [trade.id],
        values: { limit: effective, size: trade.size, symbol: trade.symbol },
      },
      idempotencyKey: key({
        rule: 'position_limit',
        packVersion,
        accountId: account.id,
        tradeId: trade.id,
        size: trade.size,
      }),
    });
  }

  return { decisions };
}

/**
 * Positions still open past the firm's flat-by time, or held over the weekend.
 * `weekend` additionally requires the trade to be open on the last session of
 * the trading week, which is why the weekday check is here and not in config.
 */
export function evaluateHoldingWindow(
  ruleId: 'overnight_holding' | 'weekend_holding',
  rule: z.infer<typeof holdingWindowSchema>,
  session: SessionConfig,
  input: EvaluationInput,
  packVersion: string
): { decisions: BreachDecision[] } {
  const { account, trades } = input;
  const decisions: BreachDecision[] = [];

  for (const trade of trades) {
    // A trade breaches if it was STILL OPEN at the cutoff: either it never
    // closed, or it closed after it.
    const closeAt = trade.closeTime;
    const stillOpen = trade.isOpen || !closeAt;
    const crossedCutoff = stillOpen || isAtOrAfterLocalTime(closeAt!, rule.flat_by, session);
    if (!crossedCutoff) continue;

    if (ruleId === 'weekend_holding') {
      const weekday = sessionWeekday(closeAt ?? trade.openTime, session);
      // Friday (5) into the weekend, or a position opened on the weekend itself.
      if (weekday !== 5 && weekday !== 6 && weekday !== 0) continue;
    }

    const label = ruleId === 'weekend_holding' ? 'over the weekend' : 'overnight';
    decisions.push({
      ruleId,
      accountId: account.id,
      action: rule.action,
      exceededBy: null,
      evidence: {
        limit: `All positions must be flat by ${rule.flat_by} ${session.timezone}`,
        observed: `${trade.symbol} held ${label}`,
        math: `position ${stillOpen ? 'still open' : `closed ${closeAt}`} against a ${rule.flat_by} cutoff`,
        tradeIds: [trade.id],
        values: { flatBy: rule.flat_by, symbol: trade.symbol, stillOpen: stillOpen ? 'true' : 'false' },
      },
      idempotencyKey: key({ rule: ruleId, packVersion, accountId: account.id, tradeId: trade.id }),
    });
  }

  return { decisions };
}
