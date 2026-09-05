import { buildAccount, buildViolationById, buildViolationDetail } from '@/lib/mock/builders';
import { violationLabel } from '@/lib/violations/labels';
import { RULE_PACK_PRESETS } from '@/lib/rulepack/presets';
import type { EvaluationInput, TradeInput } from '@/lib/rulepack/types';
import { computeHeadroom } from './headroom';
import type { VerifiedTraderAccess } from './tokens';
import type { TraderClosedTrade, TraderView, TraderViolationSummary } from './data';

/**
 * DEMO_MODE fixtures for the trader-facing surface — same chokepoint pattern
 * as `src/lib/disputes/demo.ts` and `src/lib/reports/violation/demo.ts`:
 * never touches Supabase, never calls `verifyTraderToken` (which needs the
 * admin client, structurally disabled in demo mode).
 *
 * A trader link in demo mode is always the single fixed token below, and it
 * always resolves to the same mock account — there is no issuance flow to
 * mint a "real" one against, so a fixed token is the only thing a public demo
 * URL can hand out.
 */

/** The only token the trader surface accepts while DEMO_MODE is on. */
export const DEMO_TRADER_TOKEN = 'demo';

const DEMO_TENANT_ID = 'demo-tenant';

/**
 * Mock account 100185 (login 500655) in the seeded FOREX dataset
 * (src/lib/mock/dataset.forex.ts) has two violations — 'grid' and
 * 'martingale' — so the demo trader view always has something to show in
 * both the headroom and violation-reports sections. Violation ids therefore
 * come out as `100185-grid` and `100185-martingale`, which
 * `buildDemoViolationReport` (src/lib/reports/violation/demo.ts) already
 * accepts unmodified.
 */
const DEMO_ACCOUNT_ID = '100185';

/** A plausible active pack for the demo account — used to compute REAL headroom, not hard-coded numbers. */
const DEMO_PRESET_ID = 'topstep-style';

/** The (tenant, account) pair the fixed demo token resolves to. */
export function demoVerifiedAccess(): VerifiedTraderAccess {
  return { tokenId: 'demo-token', tenantId: DEMO_TENANT_ID, accountId: DEMO_ACCOUNT_ID };
}

/** The mock account's flagged trades, reshaped into the evaluator's TradeInput. */
function demoTrades(): TradeInput[] {
  const detail = buildViolationDetail(DEMO_ACCOUNT_ID);
  return (detail.flaggedTrades ?? []).map((t) => ({
    id: String(t.tradeId),
    symbol: String(t.symbol),
    openTime: String(t.openTime),
    closeTime: String(t.closeTime),
    profit: Number(t.profit),
    size: Number(t.lots),
    isOpen: false,
  }));
}

/** The trader view for the fixed demo account, assembled from the mock dataset. */
export function buildDemoTraderView(): TraderView {
  const account = buildAccount(DEMO_ACCOUNT_ID);
  const preset = RULE_PACK_PRESETS.find((p) => p.id === DEMO_PRESET_ID);
  const trades = demoTrades();

  const evaluationInput: EvaluationInput = {
    account: {
      id: account.accountId,
      login: account.login,
      phase: 'funded',
      startingBalance: account.startingBalance,
      currentBalance: account.balance,
      currentEquity: account.balance,
    },
    trades,
    now: new Date().toISOString(),
  };

  // The mock dataset always ships this preset; the fallback only guards
  // against the preset list ever being renamed out from under this file.
  const headroom = preset
    ? computeHeadroom(preset.pack, evaluationInput)
    : { accountId: account.accountId, items: [], skipped: [] };

  const recentClosedTrades: TraderClosedTrade[] = trades.map((t) => ({
    id: t.id,
    symbol: t.symbol,
    closeTime: t.closeTime!,
    profit: t.profit,
  }));

  const violations: TraderViolationSummary[] = account.violations.map((v) => {
    const id = `${DEMO_ACCOUNT_ID}-${v.violationType}`;
    const row = buildViolationById(id);
    return {
      id,
      ruleLabel: violationLabel(v.violationType),
      severity: row ? String(row.severity) : 'medium',
      detectedAt: v.detectedAt,
    };
  });

  return {
    account: {
      login: account.login,
      phase: 'funded',
      startingBalance: account.startingBalance,
      currentBalance: account.balance,
      currentEquity: account.balance,
    },
    headroom,
    recentClosedTrades,
    violations,
  };
}
