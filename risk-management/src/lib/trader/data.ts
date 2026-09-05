import { tenantDb } from '@/lib/db/tenant-scoped';
import { violationLabel } from '@/lib/violations/labels';
import { activePack, type StoredRulePack } from '@/lib/rulepack/store';
import type { EvaluationInput, TradeInput } from '@/lib/rulepack/types';
import { DEMO_MODE } from '@/lib/demo';
import { buildDemoTraderView } from './demo';
import { computeHeadroom, type HeadroomResult } from './headroom';

/**
 * Builds the trader-facing view from the same tables the operator dashboard
 * reads, scoped to exactly one account.
 *
 * ASSUMPTIONS this module makes, because the schema does not (yet) record
 * them explicitly — flagged here rather than buried, since a wrong guess in
 * this file is a wrong number on a trader's screen:
 *
 *  - `accounts` has no per-account asset-class column (forex vs futures) and
 *    no FK to `connections`, which is the only place that split is recorded
 *    today (per-tenant-per-provider, not per-account). This tries the
 *    tenant's active FUTURES pack first, then FOREX, and uses whichever
 *    exists. A tenant running an active pack on BOTH asset classes has no way
 *    to be disambiguated from `accounts` alone today — that is a real schema
 *    gap, not a choice made here, and is called out in the report.
 *  - `accounts.account_size` is used as `startingBalance` (the challenge's
 *    opening balance). There is no separate "true starting balance" column;
 *    `starting_day_balance`/`starting_day_equity` reset daily and answer a
 *    different question.
 *  - `EquitySnapshot[]` (intraday ticks) has no backing table. Any pack
 *    running `drawdown.mode: trailing_intraday` or
 *    `daily_loss.basis: highest_equity_of_day` will come back `skipped` for
 *    this account, honestly, rather than silently applying a laxer model —
 *    same behaviour the live evaluator has today when snapshots are missing.
 */

export interface TraderAccountSummary {
  login: string;
  phase: string;
  startingBalance: number;
  currentBalance: number;
  currentEquity: number;
}

export interface TraderClosedTrade {
  id: string;
  symbol: string;
  closeTime: string;
  profit: number;
}

/**
 * One decision recorded against this account, reduced to what the trader's own
 * page shows. Deliberately NOT the violation row: no deduction amount, no
 * internal notes, no details_json — the full record is served separately,
 * behind the same token, by `/api/trader/[token]/violations/[id]/report`.
 */
export interface TraderViolationSummary {
  id: string;
  ruleLabel: string;
  severity: string;
  detectedAt: string;
}

export interface TraderView {
  account: TraderAccountSummary;
  headroom: HeadroomResult;
  recentClosedTrades: TraderClosedTrade[];
  violations: TraderViolationSummary[];
}

const RECENT_TRADES_LIMIT = 20;
const RECENT_VIOLATIONS_LIMIT = 50;

/**
 * Everything the trader page needs for one account, scoped by tenant. The
 * caller (the trader API route) must already have verified the token and
 * derived `tenantId`/`accountId` from IT, never from anything in the request
 * — this function trusts its arguments completely.
 */
export async function loadTraderView(
  tenantId: string,
  accountId: string
): Promise<TraderView | null> {
  // DEMO_MODE has no writable database and no real tenant/account to scope
  // to — the caller (the trader API route / page) has already resolved the
  // fixed demo token before calling this, so the arguments above are ignored
  // rather than used to reach Supabase.
  if (DEMO_MODE) return buildDemoTraderView();

  const db = tenantDb(tenantId, 'loadTraderView');

  const { data: accountRow, error: accountError } = await db
    .from('accounts')
    .eq('id', accountId)
    .maybeSingle();
  if (accountError || !accountRow) return null;

  const account = accountRow as {
    id: string;
    login: string;
    phase: 'challenge' | 'verification' | 'funded';
    account_size: number;
    balance: number;
    equity: number;
  };

  const { data: tradeRows, error: tradesError } = await db
    .from('trades')
    .eq('account_id', accountId)
    .order('open_time', { ascending: true });
  if (tradesError) throw tradesError;

  const trades: TradeInput[] = (tradeRows ?? []).map((row) => {
    const t = row as {
      id: string;
      symbol: string;
      open_time: string;
      close_time: string | null;
      profit: number;
      lot_size: number;
    };
    return {
      id: t.id,
      symbol: t.symbol,
      openTime: t.open_time,
      closeTime: t.close_time,
      profit: Number(t.profit),
      size: Number(t.lot_size),
      isOpen: t.close_time === null,
    };
  });

  // The account's own decisions, for the "Full decision record" links. Only
  // the four fields the trader page renders are selected — a `select('*')`
  // here would pull deduction amounts and details_json onto a surface that
  // must not show them.
  const { data: violationRows, error: violationsError } = await db
    .select('violations', 'id, violation_type, severity, detected_at')
    .eq('account_id', accountId)
    .order('detected_at', { ascending: false });
  if (violationsError) throw violationsError;

  // Capped in memory rather than with `.limit()`, matching how
  // `recentClosedTrades` below bounds its own list. One account's violation
  // history is small; the trades query above is the large one and is already
  // unbounded for the same reason (the evaluator needs the whole tape).
  const violations: TraderViolationSummary[] = (violationRows ?? [])
    .slice(0, RECENT_VIOLATIONS_LIMIT)
    .map((row) => {
      const r = row as unknown as {
        id: string;
        violation_type: string;
        severity: string;
        detected_at: string;
      };
      return {
        id: r.id,
        ruleLabel: violationLabel(r.violation_type),
        severity: r.severity,
        detectedAt: r.detected_at,
      };
    });

  const pack = (await activePack(tenantId, 'futures')) ?? (await activePack(tenantId, 'forex'));
  if (!pack) return null;

  const evaluationInput: EvaluationInput = {
    account: {
      id: account.id,
      login: account.login,
      phase: account.phase,
      startingBalance: Number(account.account_size),
      currentBalance: Number(account.balance),
      currentEquity: Number(account.equity),
    },
    trades,
    now: new Date().toISOString(),
  };

  const headroom = computeHeadroom(pack.pack, evaluationInput);

  const recentClosedTrades = [...trades]
    .filter((t) => !t.isOpen && t.closeTime)
    .sort((a, b) => Date.parse(b.closeTime!) - Date.parse(a.closeTime!))
    .slice(0, RECENT_TRADES_LIMIT)
    .map((t) => ({ id: t.id, symbol: t.symbol, closeTime: t.closeTime!, profit: t.profit }));

  return {
    account: {
      login: account.login,
      phase: account.phase,
      startingBalance: Number(account.account_size),
      currentBalance: Number(account.balance),
      currentEquity: Number(account.equity),
    },
    headroom,
    recentClosedTrades,
    violations,
  };
}

export type { StoredRulePack };
