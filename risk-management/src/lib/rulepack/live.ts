import { globalTable, tenantDb } from '@/lib/db/tenant-scoped';
import { loadEquitySnapshots } from '@/lib/ingest/snapshots';
import { evaluateRulePack } from './evaluate';
import { activePack, packVersionKey, type StoredRulePack } from './store';
import type { RuleId } from './schema';
import type { BreachDecision, EvaluationInput, TradeInput } from './types';

/**
 * The live monitoring pass — Flow 2 of docs/HOW-IT-WORKS.md.
 *
 * Until now the rule-pack engine was only ever reached from shadow mode
 * (backtest.ts) and the impact preview (impact.ts). Both are pure functions
 * whose CALLERS assemble `EvaluationInput`; nothing assembled it from the live
 * tables, so the engine that the whole product is built around never ran
 * against a real account book. This module is that assembly, and it is
 * deliberately the same shape the other two callers use so the three cannot
 * drift:
 *
 *   accounts    → the ingested `accounts` rows (as the impact route does)
 *   trades      → the ingested `trades` rows  (as src/lib/trader/data.ts does)
 *   snapshots   → loadEquitySnapshots()       (src/lib/ingest/snapshots.ts)
 *   newsEvents  → the shared economic calendar
 *
 * DETERMINISM. `now` is injected, never read from the clock here, and every
 * window is derived from it. The same tape and the same pack version therefore
 * produce the same decisions and the same idempotency keys on every run, which
 * is what lets persistence dedup by input instead of by a clock window.
 *
 * HONESTY. Two things are reported rather than silently smoothed over:
 * a rule the engine could not evaluate comes back in `skipped` (never as "no
 * breach"), and a tenant with no active pack comes back with `pack: null` so
 * the caller can say `none_active` instead of reporting zero breaches.
 *
 * ASSET CLASS. `accounts` carries no asset-class column — the split is recorded
 * only per (tenant, provider) on `connections` (see the same limitation noted
 * in src/lib/trader/data.ts). A tenant with an active pack on BOTH classes
 * therefore cannot have its book split from `accounts` alone. Rather than
 * evaluate every account twice under two different rulebooks, the caller passes
 * the accounts it has already evaluated in `excludeAccountIds`; this module
 * reports how many it skipped for that reason so the omission is visible.
 */

/** Accounts that are still live enough to breach. */
const OPEN_PHASES = ['challenge', 'verification', 'funded'] as const;

/**
 * How much history each run replays. Rules that span days (consistency,
 * min_trading_days, inactivity, trailing drawdown) need more than the current
 * session; loading an unbounded tape for every account on every cron does not
 * scale. 90 days matches the shadow-mode window a firm is onboarded on.
 */
export const LIVE_LOOKBACK_DAYS = 90;

const MAX_ACCOUNTS_PER_RUN = 5000;
const ACCOUNT_ID_CHUNK = 200;
const SNAPSHOT_CONCURRENCY = 5;

export interface LiveAccountEvaluation {
  /** `accounts.id`. Also `BreachDecision.accountId`. */
  accountId: string;
  login: string;
  decisions: BreachDecision[];
  skipped: Array<{ ruleId: RuleId; reason: string }>;
}

export interface LiveEvaluation {
  /** Null when the tenant has no active pack for this asset class. */
  pack: StoredRulePack | null;
  /** `packVersionKey(pack)` — the version every decision here was made under. */
  packVersion: string | null;
  results: LiveAccountEvaluation[];
  /** Accounts in the book this run did not evaluate (already done this run). */
  skippedAccounts: number;
}

export interface EvaluateTenantLiveParams {
  tenantId: string;
  assetClass: 'forex' | 'futures';
  /** Evaluation instant. Injected — see DETERMINISM above. */
  now: string;
  /** Accounts already evaluated under another asset class this run. */
  excludeAccountIds?: ReadonlySet<string>;
  lookbackDays?: number;
}

interface AccountRow {
  id: string;
  login: string;
  phase: (typeof OPEN_PHASES)[number];
  account_size: number;
  balance: number;
  equity: number;
}

interface TradeRow {
  id: string;
  account_id: string;
  symbol: string;
  asset_class: string | null;
  open_time: string;
  close_time: string | null;
  profit: string | number;
  lot_size: string | number;
}

interface NewsRow {
  currency: string;
  impact_level: 'red' | 'orange' | 'yellow';
  scheduled_at: string;
}

function toTradeInput(row: TradeRow): TradeInput {
  return {
    id: row.id,
    symbol: row.symbol,
    symbolClass: row.asset_class ?? undefined,
    openTime: row.open_time,
    closeTime: row.close_time,
    profit: Number(row.profit),
    size: Number(row.lot_size),
    isOpen: row.close_time === null,
  };
}

/**
 * Evaluate one tenant's live account book against its active pack for one
 * asset class. Reads only; persistence is `persistBreachDecisions`.
 */
export async function evaluateTenantLive(
  params: EvaluateTenantLiveParams
): Promise<LiveEvaluation> {
  const { tenantId, assetClass, now } = params;

  const pack = await activePack(tenantId, assetClass);
  if (!pack) {
    // NOT "no breaches". The caller reports this as `none_active`, because a
    // tenant with no rulebook has not been checked — the distinction between
    // "clean" and "not evaluated" is the one this platform must never blur.
    return { pack: null, packVersion: null, results: [], skippedAccounts: 0 };
  }

  const db = tenantDb(tenantId, 'evaluateTenantLive');
  const lookbackDays = params.lookbackDays ?? LIVE_LOOKBACK_DAYS;
  const windowStart = new Date(
    Date.parse(now) - lookbackDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: accountRows, error: accountsError } = await db
    .select('accounts', 'id, login, phase, account_size, balance, equity')
    .eq('is_active', true)
    .in('phase', [...OPEN_PHASES])
    .limit(MAX_ACCOUNTS_PER_RUN)
    .returns<AccountRow[]>();
  if (accountsError) throw accountsError;

  const exclude = params.excludeAccountIds ?? new Set<string>();
  const all = accountRows ?? [];
  const accounts = all.filter((a) => !exclude.has(a.id));
  const skippedAccounts = all.length - accounts.length;

  if (accounts.length === 0) {
    return { pack, packVersion: packVersionKey(pack), results: [], skippedAccounts };
  }

  const accountIds = accounts.map((a) => a.id);
  const tradesByAccount = await loadTrades(db, accountIds, windowStart);
  const newsEvents = await loadNewsEvents(windowStart, now);

  const packVersion = packVersionKey(pack);
  const results: LiveAccountEvaluation[] = [];

  // Snapshots are loaded per account through the existing loader rather than
  // re-implementing a batched query here; bounded so one tenant's book cannot
  // hold the whole connection pool for the length of its run.
  for (let i = 0; i < accounts.length; i += SNAPSHOT_CONCURRENCY) {
    const batch = accounts.slice(i, i + SNAPSHOT_CONCURRENCY);
    const inputs = await Promise.all(
      batch.map(async (row): Promise<EvaluationInput> => {
        const snapshots = await loadEquitySnapshots(tenantId, row.id, {
          from: windowStart,
          to: now,
        });
        return {
          account: {
            id: row.id,
            login: row.login,
            phase: row.phase,
            // `account_size` is the challenge's opening balance; there is no
            // separate starting-balance column (same assumption documented in
            // src/lib/trader/data.ts).
            startingBalance: Number(row.account_size),
            currentBalance: Number(row.balance),
            currentEquity: Number(row.equity),
          },
          trades: tradesByAccount.get(row.id) ?? [],
          snapshots: snapshots.length > 0 ? snapshots : undefined,
          newsEvents: newsEvents.length > 0 ? newsEvents : undefined,
          now,
        };
      })
    );

    for (let j = 0; j < inputs.length; j++) {
      const evaluation = evaluateRulePack(pack.pack, inputs[j], packVersion);
      results.push({
        accountId: batch[j].id,
        login: batch[j].login,
        decisions: evaluation.decisions,
        skipped: evaluation.skipped,
      });
    }
  }

  return { pack, packVersion, results, skippedAccounts };
}

async function loadTrades(
  db: ReturnType<typeof tenantDb>,
  accountIds: string[],
  windowStart: string
): Promise<Map<string, TradeInput[]>> {
  const byAccount = new Map<string, TradeInput[]>();

  for (let i = 0; i < accountIds.length; i += ACCOUNT_ID_CHUNK) {
    const { data, error } = await db
      .select(
        'trades',
        'id, account_id, symbol, asset_class, open_time, close_time, profit, lot_size'
      )
      .in('account_id', accountIds.slice(i, i + ACCOUNT_ID_CHUNK))
      .gte('open_time', windowStart)
      .order('open_time', { ascending: true })
      .returns<TradeRow[]>();
    if (error) throw error;

    for (const row of data ?? []) {
      const list = byAccount.get(row.account_id);
      if (list) list.push(toTradeInput(row));
      else byAccount.set(row.account_id, [toTradeInput(row)]);
    }
  }

  return byAccount;
}

/**
 * The economic calendar, in the shape the news rule takes. Read through
 * `globalTable` because it is genuinely shared reference data — the same
 * release is the same release for every firm — which is why crossing the
 * tenant boundary here is a named call rather than an omission.
 */
async function loadNewsEvents(
  from: string,
  to: string
): Promise<NonNullable<EvaluationInput['newsEvents']>> {
  const { data, error } = await globalTable('news_events')
    .select('currency, impact_level, scheduled_at')
    .gte('scheduled_at', from)
    .lte('scheduled_at', to)
    .order('scheduled_at', { ascending: true })
    .returns<NewsRow[]>();

  if (error) throw error;

  return (data ?? []).map((row) => ({
    at: row.scheduled_at,
    impact: row.impact_level,
    currency: row.currency,
  }));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface PersistedDecisions {
  /**
   * `idempotencyKey → breach_decisions.id` for every decision now on record,
   * whether this run wrote it or a previous one did. The caller links the
   * violation row to the decision through this.
   */
  idByKey: Map<string, string>;
  /** Rows this call actually inserted. Never a count of attempts. */
  inserted: number;
  /** Decisions that were already on record — an identical re-run. */
  alreadyRecorded: number;
}

interface DecisionRow {
  id: string;
  idempotency_key: string;
}

/**
 * Write live breach decisions to `breach_decisions` with `enforced: true`.
 *
 * `UNIQUE (tenant_id, idempotency_key, enforced)` is what makes a repeat run a
 * no-op: the key is a hash over pack version + account + rule + measured
 * inputs, so an unchanged tape produces the same key and conflicts with itself.
 * That is the invariant the old six-hour clock window could not hold — it gave
 * a different answer depending on when the cron happened to fire, and made
 * replay impossible.
 *
 * Decisions carrying `indeterminate` ARE persisted. A rule the engine could not
 * evaluate is a fact worth keeping (it is the difference between "clean" and
 * "not checked"); what it must never do is produce a violation or an
 * enforcement item, which is the caller's job to honour.
 */
export async function persistBreachDecisions(
  tenantId: string,
  pack: StoredRulePack,
  decisions: BreachDecision[]
): Promise<PersistedDecisions> {
  const idByKey = new Map<string, string>();
  if (decisions.length === 0) return { idByKey, inserted: 0, alreadyRecorded: 0 };

  const db = tenantDb(tenantId, 'persistBreachDecisions');

  // One decision per idempotency key: the engine can legitimately emit the same
  // key twice within a run (e.g. the same rule re-derived per session day with
  // identical inputs), and inserting both would violate the unique index.
  const unique = new Map<string, BreachDecision>();
  for (const d of decisions) if (!unique.has(d.idempotencyKey)) unique.set(d.idempotencyKey, d);
  const keys = [...unique.keys()];

  for (let i = 0; i < keys.length; i += ACCOUNT_ID_CHUNK) {
    const { data, error } = await db
      .select('breach_decisions', 'id, idempotency_key')
      .eq('enforced', true)
      .in('idempotency_key', keys.slice(i, i + ACCOUNT_ID_CHUNK))
      .returns<DecisionRow[]>();
    if (error) throw error;
    for (const row of data ?? []) idByKey.set(row.idempotency_key, row.id);
  }

  const alreadyRecorded = idByKey.size;
  const toInsert = [...unique.values()].filter((d) => !idByKey.has(d.idempotencyKey));
  if (toInsert.length === 0) return { idByKey, inserted: 0, alreadyRecorded };

  const rows = toInsert.map((d) => decisionRow(pack, d));

  const { data: insertedRows, error: insertError } = await db
    .insert('breach_decisions', rows)
    .select('id, idempotency_key')
    .returns<DecisionRow[]>();

  if (!insertError && insertedRows) {
    for (const row of insertedRows) idByKey.set(row.idempotency_key, row.id);
    return { idByKey, inserted: insertedRows.length, alreadyRecorded };
  }

  // A batch insert is all-or-nothing, so one conflicting row (a concurrent cron
  // that recorded the same decision between our read and our write) rejects the
  // whole batch. Fall back to per-row inserts so the rest still land, and count
  // only what actually persisted.
  let inserted = 0;
  let raced = 0;
  for (let i = 0; i < toInsert.length; i++) {
    const { data, error } = await db
      .insert('breach_decisions', rows[i])
      .select('id, idempotency_key')
      .single();

    if (!error && data) {
      const row = data as unknown as DecisionRow;
      idByKey.set(row.idempotency_key, row.id);
      inserted++;
      continue;
    }

    const key = toInsert[i].idempotencyKey;
    const { data: existing } = await db
      .select('breach_decisions', 'id, idempotency_key')
      .eq('enforced', true)
      .eq('idempotency_key', key)
      .limit(1)
      .returns<DecisionRow[]>();

    if (existing && existing.length > 0) {
      idByKey.set(key, existing[0].id);
      raced++;
      continue;
    }

    throw error ?? insertError;
  }

  return { idByKey, inserted, alreadyRecorded: alreadyRecorded + raced };
}

function decisionRow(pack: StoredRulePack, decision: BreachDecision): Record<string, unknown> {
  return {
    rule_pack_id: pack.id,
    rule_pack_version: pack.version,
    account_id: decision.accountId,
    rule_id: decision.ruleId,
    action: decision.action,
    exceeded_by: decision.exceededBy,
    session_day: decision.evidence.sessionDay ?? null,
    evidence_json: decision.indeterminate
      ? { ...decision.evidence, indeterminate: decision.indeterminate }
      : decision.evidence,
    enforced: true,
    idempotency_key: decision.idempotencyKey,
  };
}
