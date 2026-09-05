import { FUTURES_CONFIG } from '@/config/violations';
import {
  VIOLATION_LABELS,
  severityFromDeduction,
  type NormalizedAccount,
  type NormalizedTrade,
  type NormalizedViolation,
} from '@/lib/providers/types';

/**
 * Futures risk engine — parallel to the forex engine in
 * `src/lib/payouts/local-analysis.ts`. Forex rules (lot limits, news windows)
 * don't translate to futures, where risk is governed by account-level drawdown
 * and contract limits. These are pure functions over normalized trades +
 * account config, so they work for any futures provider (Tradovate, Rithmic,
 * TopstepX, CQG, NinjaTrader).
 *
 * For native-violation providers (Tradovate auto-liq, Rithmic RMS, CQG) the
 * adapter can instead surface the platform's server-computed breaches; this
 * engine is the fallback for raw-data providers (e.g. TopstepX, which exposes
 * only balance + fills and requires us to compute drawdown/daily-loss).
 */

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function mkViolation(
  account: NormalizedAccount,
  type: NormalizedViolation['type'],
  description: string,
  deductionAmount: number,
  affectedTradeIds: string[]
): NormalizedViolation {
  return {
    id: `${account.id}-${type}`,
    accountId: account.id,
    type,
    label: VIOLATION_LABELS[type],
    assetClass: 'futures',
    severity: severityFromDeduction(deductionAmount),
    detectedAt: new Date().toISOString(),
    description,
    deductionAmount,
    affectedTradeIds,
    status: 'detected',
  };
}

/** Daily realized loss exceeding maxDailyLossPct of starting balance. */
export function detectDailyLoss(account: NormalizedAccount, trades: NormalizedTrade[]): NormalizedViolation[] {
  const limitPct = account.maxDailyLossPct || FUTURES_CONFIG.default_max_daily_loss_pct;
  const limit = account.startingBalance * limitPct;
  const byDay = new Map<string, { pnl: number; ids: string[] }>();
  for (const t of trades) {
    const k = dayKey(t.closeTime || t.openTime);
    const e = byDay.get(k) || { pnl: 0, ids: [] };
    e.pnl += t.profit;
    e.ids.push(t.id);
    byDay.set(k, e);
  }
  const out: NormalizedViolation[] = [];
  for (const [day, e] of byDay) {
    if (e.pnl < -limit) {
      out.push(
        mkViolation(
          account,
          'daily_loss',
          `Daily loss of $${Math.abs(e.pnl).toFixed(0)} on ${day} exceeded the $${limit.toFixed(0)} daily loss limit (${(limitPct * 100).toFixed(1)}% of $${account.startingBalance.toLocaleString()}).`,
          Math.abs(e.pnl) - limit,
          e.ids
        )
      );
    }
  }
  return out;
}

/** Trailing peak-to-trough equity drawdown breach. */
export function detectTrailingDrawdown(account: NormalizedAccount, trades: NormalizedTrade[]): NormalizedViolation[] {
  const limitPct = account.maxTrailingDrawdownPct || FUTURES_CONFIG.default_max_trailing_drawdown_pct;
  const sorted = [...trades].sort((a, b) => new Date(a.closeTime || a.openTime).getTime() - new Date(b.closeTime || b.openTime).getTime());
  let equity = account.startingBalance;
  let peak = equity;
  let maxDrawdown = 0;
  const ids: string[] = [];
  for (const t of sorted) {
    equity += t.profit;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      ids.push(t.id);
    }
  }
  const limit = account.startingBalance * limitPct;
  if (maxDrawdown > limit) {
    return [
      mkViolation(
        account,
        'trailing_drawdown',
        `Trailing drawdown of $${maxDrawdown.toFixed(0)} breached the $${limit.toFixed(0)} limit (${(limitPct * 100).toFixed(1)}% trailing). Account locked from trading.`,
        maxDrawdown - limit,
        ids.slice(-3)
      ),
    ];
  }
  return [];
}

/** Concurrent contracts exceeding the account's position limit. */
export function detectPositionLimit(account: NormalizedAccount, trades: NormalizedTrade[]): NormalizedViolation[] {
  const limit =
    account.maxPositionSize ||
    FUTURES_CONFIG.position_limits_by_size[account.startingBalance] ||
    10;
  const offenders = trades.filter((t) => t.sizeNative > limit);
  if (offenders.length === 0) return [];
  const worst = offenders.reduce((m, t) => Math.max(m, t.sizeNative), 0);
  return [
    mkViolation(
      account,
      'position_limit',
      `Position of ${worst} contracts exceeded the ${limit}-contract limit for a $${account.startingBalance.toLocaleString()} account.`,
      offenders.reduce((s, t) => s + Math.max(0, t.profit), 0),
      offenders.map((t) => t.id)
    ),
  ];
}

export interface FuturesAnalysis {
  account: NormalizedAccount;
  violations: NormalizedViolation[];
  totalDeductions: number;
  breakdownByType: Record<string, number>;
}

/** Run the full futures rule set for one account. */
export function runFuturesAnalysis(account: NormalizedAccount, trades: NormalizedTrade[]): FuturesAnalysis {
  const violations = [
    ...detectDailyLoss(account, trades),
    ...detectTrailingDrawdown(account, trades),
    ...detectPositionLimit(account, trades),
  ];
  const breakdownByType: Record<string, number> = {};
  for (const v of violations) breakdownByType[v.type] = (breakdownByType[v.type] || 0) + v.deductionAmount;
  return {
    account,
    violations,
    totalDeductions: violations.reduce((s, v) => s + v.deductionAmount, 0),
    breakdownByType,
  };
}
