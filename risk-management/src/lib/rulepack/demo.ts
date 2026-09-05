import { presetById } from './presets';
import { contentHashOf, packVersionKey, type StoredRulePack } from './store';
import { runBacktest, type BacktestResult } from './backtest';
import type { AccountContext, EquitySnapshot, EvaluationInput, TradeInput } from './types';

/**
 * Demo mode for rule packs and the shadow-mode backtest.
 *
 * The rule pack + backtest flow is this product's core feature — "bring your
 * own history, watch us reproduce your platform's breaches and show you what
 * it missed" — so a public demo that shows an empty list and a 404 hides the
 * one thing worth showing. This module is the single source of mock rule
 * packs and a mock backtest run, built from the SAME preset and evaluation
 * code production uses, so the demo can never show a reconciliation the real
 * engine would not also produce.
 *
 * Everything here is deterministic: fixed timestamps, a seeded PRNG for the
 * synthetic trade tape, no `Date.now()` / `Math.random()`. Two calls with the
 * same arguments must return byte-identical results, because the demo is
 * public and cached responses / repeated runs must never disagree.
 */

const DEMO_TENANT_ID = 'demo-tenant';

// ── Seeded PRNG ──────────────────────────────────────────────────────────────
// mulberry32: tiny, deterministic, no external dependency. Good enough for a
// synthetic trade tape; not used anywhere a real distribution matters.
function mulberry32(seed: number): () => number {
  let a = seed;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pack(presetId: string): ReturnType<typeof presetById> {
  const preset = presetById(presetId);
  if (!preset) throw new Error(`Demo pack references unknown preset "${presetId}"`);
  return preset;
}

function storedPack(args: {
  id: string;
  presetId: string;
  version: number;
  status: StoredRulePack['status'];
  derivedFrom: string | null;
  createdAt: string;
  approvedBy?: string | null;
  approvedAt?: string | null;
}): StoredRulePack {
  const preset = pack(args.presetId)!;
  return {
    id: args.id,
    tenantId: DEMO_TENANT_ID,
    name: preset.pack.name,
    assetClass: preset.assetClass,
    version: args.version,
    status: args.status,
    pack: preset.pack,
    contentHash: contentHashOf(preset.pack),
    derivedFrom: args.derivedFrom,
    approvedBy: args.approvedBy ?? null,
    approvedAt: args.approvedAt ?? null,
    createdAt: args.createdAt,
  };
}

/**
 * Three sample packs, one per shape a firm actually recognises itself in:
 * an active intraday-trailing futures pack (Apex), a draft end-of-day
 * futures pack still being tuned (TopStep), and an active static-drawdown
 * forex pack (FTMO). Fixed timestamps only — this is public, cached data.
 */
export const DEMO_RULE_PACKS: StoredRulePack[] = [
  storedPack({
    id: 'demo-apex-futures',
    presetId: 'apex-style',
    version: 2,
    status: 'active',
    derivedFrom: 'apex-style',
    createdAt: '2026-01-05T14:00:00.000Z',
    approvedBy: 'demo-platform-ops',
    approvedAt: '2026-01-12T09:30:00.000Z',
  }),
  storedPack({
    id: 'demo-topstep-futures-draft',
    presetId: 'topstep-style',
    version: 1,
    status: 'draft',
    derivedFrom: 'topstep-style',
    createdAt: '2026-02-20T11:15:00.000Z',
  }),
  storedPack({
    id: 'demo-ftmo-forex',
    presetId: 'ftmo-style',
    version: 1,
    status: 'active',
    derivedFrom: 'ftmo-style',
    createdAt: '2026-01-08T08:00:00.000Z',
    approvedBy: 'demo-platform-ops',
    approvedAt: '2026-01-10T16:45:00.000Z',
  }),
];

export function findDemoPack(id: string): StoredRulePack | null {
  return DEMO_RULE_PACKS.find((p) => p.id === id) ?? null;
}

// ── Synthetic 90-day trade tape ──────────────────────────────────────────────

const TAPE_START = Date.parse('2026-01-01T14:00:00.000Z');
const TAPE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

interface DemoAccountSpec {
  id: string;
  login: string;
  startingBalance: number;
  /** Whether to attach intraday equity snapshots (Apex's trailing_intraday
   * drawdown mode refuses to evaluate without them). */
  withSnapshots: boolean;
  /** An oversized trade injected on day 1 to force one deterministic,
   * platform-independent breach — position_limit does not depend on
   * snapshots or RNG output, so it fires on every run regardless of seed. */
  oversizedTrade?: boolean;
}

const DEMO_ACCOUNTS: DemoAccountSpec[] = [
  { id: 'demo-acc-1', login: '100001', startingBalance: 100_000, withSnapshots: true, oversizedTrade: true },
  { id: 'demo-acc-2', login: '100002', startingBalance: 100_000, withSnapshots: true },
  { id: 'demo-acc-3', login: '100003', startingBalance: 50_000, withSnapshots: true },
  { id: 'demo-acc-4', login: '100004', startingBalance: 25_000, withSnapshots: true },
  { id: 'demo-acc-5', login: '100005', startingBalance: 150_000, withSnapshots: true },
  // No snapshots: this is the account that keeps the "trailing_intraday needs
  // intraday equity snapshots" skip alive for any pack using Apex's model.
  { id: 'demo-acc-6', login: '100006', startingBalance: 100_000, withSnapshots: false },
];

function buildAccountInput(spec: DemoAccountSpec, seed: number): EvaluationInput {
  const rng = mulberry32(seed);
  const account: AccountContext = {
    id: spec.id,
    login: spec.login,
    phase: 'funded',
    startingBalance: spec.startingBalance,
    currentBalance: spec.startingBalance,
    currentEquity: spec.startingBalance,
  };

  const trades: TradeInput[] = [];
  const snapshots: EquitySnapshot[] = [];
  let equity = spec.startingBalance;

  if (spec.oversizedTrade) {
    // Deliberate, seed-independent position_limit breach: every apex-style
    // account size in RULE_PACK_PRESETS maps to a limit under 20 contracts.
    const openAt = new Date(TAPE_START).toISOString();
    const closeAt = new Date(TAPE_START + 60 * 60 * 1000).toISOString();
    const profit = 150;
    trades.push({
      id: `${spec.id}-oversized`,
      symbol: 'ES',
      openTime: openAt,
      closeTime: closeAt,
      profit,
      size: 20,
      isOpen: false,
    });
    equity += profit;
    if (spec.withSnapshots) snapshots.push({ at: closeAt, balance: equity, equity });
  }

  for (let day = 0; day < TAPE_DAYS; day += 1) {
    const dayStart = TAPE_START + day * DAY_MS;
    // One modest trade most days; a quiet day roughly one time in five, which
    // is realistic and keeps the tape from being a mechanical straight line.
    if (rng() < 0.2) continue;

    const openAt = new Date(dayStart).toISOString();
    // Closed well inside the CME session's 16:59 flat-by cutoff, so the tape
    // does not also trip overnight_holding — that is not the story this
    // pack's demo is telling.
    const closeAt = new Date(dayStart + (2 + Math.floor(rng() * 4)) * 60 * 60 * 1000).toISOString();
    const size = 1 + Math.floor(rng() * 3); // 1..3 contracts, inside every limit
    const profit = Math.round((rng() - 0.48) * 900); // small realistic swings

    trades.push({
      id: `${spec.id}-t${day}`,
      symbol: 'ES',
      openTime: openAt,
      closeTime: closeAt,
      profit,
      size,
      isOpen: false,
    });

    equity += profit;
    if (spec.withSnapshots) {
      snapshots.push({ at: closeAt, balance: equity, equity });
    }
  }

  return {
    account,
    trades,
    snapshots: spec.withSnapshots ? snapshots : undefined,
    now: new Date(TAPE_START + TAPE_DAYS * DAY_MS).toISOString(),
  };
}

/** The default synthetic tape used when a caller does not supply its own. */
export function buildDemoAccountInputs(): EvaluationInput[] {
  return DEMO_ACCOUNTS.map((spec, i) => buildAccountInput(spec, 0x2026_0101 + i));
}

/**
 * Run the real backtest engine against a demo pack.
 *
 * `providerReported` is always empty here: the demo has no incumbent platform
 * to reconcile against, so every engine finding lands in `engineOnly` (the
 * "found breaches your platform missed" bucket) and `providerOnly` — the
 * blocking one — is always empty. That is what "the demo pack is activatable"
 * means: nothing here would ever tell a firm this pack relaxes its rules.
 */
export function runDemoBacktest(id: string, accountInputs?: EvaluationInput[]): BacktestResult | null {
  const found = findDemoPack(id);
  if (!found) return null;

  const inputs = accountInputs && accountInputs.length > 0 ? accountInputs : buildDemoAccountInputs();
  return runBacktest(found.pack, packVersionKey(found), inputs, []);
}

// ── Backtest history ─────────────────────────────────────────────────────────
// One prior run per active pack, in the same row shape `backtest_runs`
// carries live (snake_case) — the history list on the detail page reads those
// fields directly off whatever GET /backtest returns.

interface DemoBacktestRun {
  id: string;
  status: 'complete';
  window_start: string;
  window_end: string;
  accounts_evaluated: number;
  engine_breaches: number;
  provider_breaches: number;
  reconciliation_json: BacktestResult['reconciliation'];
  skipped_json: BacktestResult['skipped'];
  created_at: string;
  completed_at: string;
}

function historyRunFor(packId: string, runId: string, createdAt: string): DemoBacktestRun {
  const result = runDemoBacktest(packId);
  if (!result) throw new Error(`No demo pack "${packId}" to build backtest history for`);
  return {
    id: runId,
    status: 'complete',
    window_start: new Date(TAPE_START).toISOString(),
    window_end: new Date(TAPE_START + TAPE_DAYS * DAY_MS).toISOString(),
    accounts_evaluated: result.accountsEvaluated,
    engine_breaches: result.engineBreaches,
    provider_breaches: result.providerBreaches,
    reconciliation_json: result.reconciliation,
    skipped_json: result.skipped,
    created_at: createdAt,
    completed_at: createdAt,
  };
}

export const DEMO_BACKTEST_HISTORY: Record<string, DemoBacktestRun[]> = {
  'demo-apex-futures': [historyRunFor('demo-apex-futures', 'demo-backtest-apex-1', '2026-01-11T10:00:00.000Z')],
  'demo-ftmo-forex': [historyRunFor('demo-ftmo-forex', 'demo-backtest-ftmo-1', '2026-01-09T10:00:00.000Z')],
};

export function findDemoBacktestHistory(id: string): DemoBacktestRun[] {
  return DEMO_BACKTEST_HISTORY[id] ?? [];
}
