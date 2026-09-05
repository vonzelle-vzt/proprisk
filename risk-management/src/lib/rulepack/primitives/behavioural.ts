import { createHash } from 'crypto';
import type { z } from 'zod';
import type { hftSchema, martingaleSchema, newsSchema } from '../schema';
import type { BreachDecision, EvaluationInput, TradeInput } from '../types';

function key(parts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

function openedAt(t: TradeInput): number {
  return Date.parse(t.openTime);
}

/**
 * High-frequency trading.
 *
 * Firms express this as a set of sliding windows — "no more than 2 trades in 3
 * seconds, 3 in 10 seconds, 30 in an hour" — so the parameter is a LIST of
 * (window, max) pairs, not one number. The engine this replaces hardcoded that
 * list in two places that had already drifted apart.
 *
 * Windows are evaluated against trade OPEN times: the prohibited behaviour is
 * firing orders in bursts, which is visible at entry regardless of how long the
 * positions are subsequently held.
 */
export function evaluateHft(
  rule: z.infer<typeof hftSchema>,
  input: EvaluationInput,
  packVersion: string
): { decisions: BreachDecision[] } {
  const { account, trades } = input;
  const sorted = [...trades].sort((a, b) => openedAt(a) - openedAt(b));
  const decisions: BreachDecision[] = [];
  // One decision per window per burst: reporting every overlapping sub-window
  // would bury the finding in duplicates of itself.
  const reported = new Set<string>();

  for (const window of rule.windows) {
    const spanMs = window.window_seconds * 1000;

    for (let i = 0; i < sorted.length; i++) {
      const start = openedAt(sorted[i]);
      const burst: TradeInput[] = [];
      for (let j = i; j < sorted.length && openedAt(sorted[j]) - start <= spanMs; j++) {
        burst.push(sorted[j]);
      }
      if (burst.length <= window.max_trades) continue;

      const dedupe = `${window.window_seconds}:${burst[0].id}`;
      if (reported.has(dedupe)) continue;
      reported.add(dedupe);
      // Skip past this burst so a 10-trade cluster reports once, not 10 times.
      i += burst.length - 1;

      decisions.push({
        ruleId: 'hft',
        accountId: account.id,
        action: rule.action,
        exceededBy: burst.length - window.max_trades,
        evidence: {
          limit: `No more than ${window.max_trades} trades within ${window.window_seconds} seconds`,
          observed: `${burst.length} trades within ${window.window_seconds} seconds`,
          math: `${burst.length} trades opened between ${burst[0].openTime} and ${burst[burst.length - 1].openTime}`,
          tradeIds: burst.map((t) => t.id),
          values: {
            windowSeconds: window.window_seconds,
            maxTrades: window.max_trades,
            observed: burst.length,
          },
        },
        idempotencyKey: key({
          rule: 'hft',
          packVersion,
          accountId: account.id,
          window: window.window_seconds,
          firstTrade: burst[0].id,
        }),
      });
    }
  }

  return { decisions };
}

/**
 * Martingale — increasing size after losses to chase a loss back.
 *
 * Detected as: a run of at least `min_losing_streak` losing trades followed by
 * a trade at least `volume_multiplier` times the size of the last loser. The
 * streak requirement is what separates martingale from ordinary position
 * sizing; a single larger trade after a single loss is not evidence of
 * anything.
 */
export function evaluateMartingale(
  rule: z.infer<typeof martingaleSchema>,
  input: EvaluationInput,
  packVersion: string
): { decisions: BreachDecision[] } {
  const { account, trades } = input;
  const closed = [...trades]
    .filter((t) => !t.isOpen)
    .sort((a, b) => Date.parse(a.closeTime || a.openTime) - Date.parse(b.closeTime || b.openTime));

  const decisions: BreachDecision[] = [];

  // Pair each qualifying losing streak with the winning trade that ended it.
  let streak: TradeInput[] = [];
  for (let i = 0; i < closed.length; i++) {
    const trade = closed[i];

    if (trade.profit < 0) {
      streak.push(trade);
      continue;
    }

    if (streak.length >= rule.min_losing_streak) {
      const lastLoser = streak[streak.length - 1];
      if (trade.size >= lastLoser.size * rule.volume_multiplier) {
        decisions.push(
          martingaleDecision(rule, account.id, streak, trade, lastLoser, packVersion)
        );
      }
    }
    streak = [];
  }

  // A size escalation can also occur while still losing — the classic doubling
  // down — which the winner-terminated walk above never sees.
  for (let i = 1; i < closed.length; i++) {
    const prev = closed[i - 1];
    const curr = closed[i];
    if (prev.profit >= 0 || curr.profit >= 0) continue;

    const run = countLosingRunEndingAt(closed, i - 1);
    if (run < rule.min_losing_streak) continue;
    if (curr.size < prev.size * rule.volume_multiplier) continue;

    decisions.push(
      martingaleDecision(rule, account.id, closed.slice(i - run, i), curr, prev, packVersion)
    );
  }

  return { decisions };
}

function countLosingRunEndingAt(trades: TradeInput[], endIndex: number): number {
  let n = 0;
  for (let i = endIndex; i >= 0 && trades[i].profit < 0; i--) n++;
  return n;
}

function martingaleDecision(
  rule: z.infer<typeof martingaleSchema>,
  accountId: string,
  streak: TradeInput[],
  escalation: TradeInput,
  lastLoser: TradeInput,
  packVersion: string
): BreachDecision {
  const multiple = lastLoser.size > 0 ? escalation.size / lastLoser.size : Infinity;
  return {
    ruleId: 'martingale',
    accountId,
    action: rule.action,
    exceededBy: null,
    evidence: {
      limit: `No size increase of ${rule.volume_multiplier}× or more after ${rule.min_losing_streak} consecutive losses`,
      observed: `${streak.length} consecutive losses followed by a ${multiple.toFixed(2)}× size increase`,
      math: `size ${escalation.size} ÷ previous ${lastLoser.size} = ${multiple.toFixed(2)}× after ${streak.length} losing trades`,
      tradeIds: [...streak.map((t) => t.id), escalation.id],
      values: {
        streakLength: streak.length,
        multiple,
        threshold: rule.volume_multiplier,
        escalationTradeId: escalation.id,
      },
    },
    idempotencyKey: key({
      rule: 'martingale',
      packVersion,
      accountId,
      escalationTradeId: escalation.id,
    }),
  };
}

/**
 * News-window trading.
 *
 * A blackout around high-impact economic releases. `applies_to` decides whether
 * the blackout covers only instruments tied to the event's currency or every
 * instrument — firms genuinely differ, and applying the wrong one either misses
 * breaches or invents them.
 */
export function evaluateNews(
  rule: z.infer<typeof newsSchema>,
  input: EvaluationInput,
  packVersion: string
): { decisions: BreachDecision[]; skipped?: string } {
  const { account, trades, newsEvents } = input;
  if (!newsEvents || newsEvents.length === 0) {
    return {
      decisions: [],
      skipped: 'no economic calendar events supplied for the evaluated period',
    };
  }

  const relevant = newsEvents.filter((e) =>
    (rule.impact_levels as readonly string[]).includes(e.impact)
  );
  const decisions: BreachDecision[] = [];

  for (const trade of trades) {
    const at = Date.parse(trade.openTime);
    for (const event of relevant) {
      const eventAt = Date.parse(event.at);
      const from = eventAt - rule.before_minutes * 60_000;
      const to = eventAt + rule.after_minutes * 60_000;
      if (at < from || at > to) continue;

      if (
        rule.applies_to === 'related_currency' &&
        !trade.symbol.toUpperCase().includes(event.currency.toUpperCase())
      ) {
        continue;
      }

      decisions.push({
        ruleId: 'news',
        accountId: account.id,
        action: rule.action,
        exceededBy: null,
        evidence: {
          limit: `No trading from ${rule.before_minutes} minutes before to ${rule.after_minutes} minutes after ${rule.impact_levels.join('/')}-impact events`,
          observed: `${trade.symbol} opened at ${trade.openTime}, inside the window around the ${event.currency} event at ${event.at}`,
          math: `window ${new Date(from).toISOString()} → ${new Date(to).toISOString()}; trade opened ${trade.openTime}`,
          tradeIds: [trade.id],
          values: {
            eventAt: event.at,
            eventCurrency: event.currency,
            impact: event.impact,
            beforeMinutes: rule.before_minutes,
            afterMinutes: rule.after_minutes,
          },
        },
        idempotencyKey: key({
          rule: 'news',
          packVersion,
          accountId: account.id,
          tradeId: trade.id,
          eventAt: event.at,
        }),
      });
      break; // One decision per trade, however many events it straddles.
    }
  }

  return { decisions };
}
