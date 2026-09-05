import { tenantDb } from '@/lib/db/tenant-scoped';
import { logError } from '@/lib/logging/logger';
import type { EquitySnapshot } from '@/lib/rulepack/types';
import type { PushSnapshotInput } from './schemas';

/**
 * Storage for the equity time series (supabase/migrations/00022_equity_snapshots.sql)
 * and the one function the evaluation path actually needs: loading a window
 * of snapshots shaped exactly as `EquitySnapshot[]`, the type
 * src/lib/rulepack/primitives/{drawdown,daily-loss}.ts already accept and
 * have never once been handed. Nothing in src/lib/rulepack is touched here —
 * this module produces its input, not the other way round.
 */

/** Raw shape written to the `equity_snapshots` table, before tenant stamping. */
export interface SnapshotWriteInput {
  accountId: string;
  capturedAt: string;
  balance: number;
  equity: number;
  openPnl?: number | null;
  source: 'poll' | 'push';
  sampleIntervalSeconds?: number | null;
}

export interface RecordSnapshotsResult {
  written: number;
  failed: number;
}

/**
 * Write a batch of snapshots for one tenant. Idempotent by construction: the
 * unique index on (tenant_id, account_id, captured_at) means a retried poll
 * or a retried push for an instant already recorded is a silent no-op, not a
 * duplicate row or an error.
 */
export async function recordSnapshots(
  tenantId: string,
  rows: SnapshotWriteInput[]
): Promise<RecordSnapshotsResult> {
  if (rows.length === 0) return { written: 0, failed: 0 };

  const db = tenantDb(tenantId, 'recordSnapshots');
  const payload = rows.map((r) => ({
    account_id: r.accountId,
    captured_at: r.capturedAt,
    balance: r.balance,
    equity: r.equity,
    open_pnl: r.openPnl ?? null,
    source: r.source,
    sample_interval_seconds: r.sampleIntervalSeconds ?? null,
  }));

  const { error } = await db.upsert('equity_snapshots', payload, {
    onConflict: 'tenant_id,account_id,captured_at',
  });

  if (error) {
    logError('recordSnapshots: upsert failed', error, {
      category: 'database',
      tenant_id: tenantId,
    });
    return { written: 0, failed: rows.length };
  }

  // The batch is a single upsert statement — Postgres/PostgREST don't hand
  // back a per-row result, so "all of it or an error" is the granularity
  // available without a second round trip per row.
  return { written: rows.length, failed: 0 };
}

export interface SnapshotWindow {
  /** Inclusive lower bound, ISO 8601. */
  from: string;
  /** Inclusive upper bound, ISO 8601. Omit for "through now". */
  to?: string;
}

interface SnapshotRow {
  captured_at: string;
  balance: string | number;
  equity: string | number;
}

/**
 * Load one account's equity time series over a window, in the exact shape
 * `EvaluationInput.snapshots` expects. Ordered ascending by `at` — the same
 * order `buildSeries` in drawdown.ts re-sorts into anyway, done here so a
 * caller that skips that re-sort still gets a sane series.
 */
export async function loadEquitySnapshots(
  tenantId: string,
  accountId: string,
  window: SnapshotWindow
): Promise<EquitySnapshot[]> {
  const db = tenantDb(tenantId, 'loadEquitySnapshots');
  let query = db
    .select('equity_snapshots', 'captured_at, balance, equity')
    .eq('account_id', accountId)
    .gte('captured_at', window.from)
    .order('captured_at', { ascending: true });

  if (window.to) query = query.lte('captured_at', window.to);

  const { data, error } = await query.returns<SnapshotRow[]>();
  if (error) throw error;

  return (data ?? []).map((row) => ({
    at: row.captured_at,
    balance: Number(row.balance),
    equity: Number(row.equity),
  }));
}

export interface SnapshotFidelity {
  /** Whether every row in the window carries a known sampling interval. */
  intervalKnown: boolean;
  /** The widest configured/reported interval among this window's rows, seconds. Null if unknown. */
  maxIntervalSeconds: number | null;
  /** The largest actual gap between consecutive samples, seconds. Null with 0-1 samples. */
  maxObservedGapSeconds: number | null;
  sampleCount: number;
}

interface FidelityRow {
  captured_at: string;
  sample_interval_seconds: number | null;
}

/**
 * Fidelity summary for a window: what a disputing trader's "how do you know
 * you didn't miss my spike" question actually needs. A 60-second poll cannot
 * see a 10-second move, so a breach decision built from these snapshots must
 * be able to cite the bound it was measured under rather than imply
 * tick-level certainty. Not wired into BreachEvidence yet (that is
 * src/lib/rulepack/**, out of scope here) — this is the data the eventual
 * caller attaches to the evidence pack.
 */
export async function getSnapshotFidelity(
  tenantId: string,
  accountId: string,
  window: SnapshotWindow
): Promise<SnapshotFidelity> {
  const db = tenantDb(tenantId, 'getSnapshotFidelity');
  let query = db
    .select('equity_snapshots', 'captured_at, sample_interval_seconds')
    .eq('account_id', accountId)
    .gte('captured_at', window.from)
    .order('captured_at', { ascending: true });

  if (window.to) query = query.lte('captured_at', window.to);

  const { data, error } = await query.returns<FidelityRow[]>();
  if (error) throw error;

  const rows = data ?? [];
  const intervalKnown = rows.length > 0 && rows.every((r) => r.sample_interval_seconds != null);
  const maxIntervalSeconds = intervalKnown
    ? Math.max(...rows.map((r) => r.sample_interval_seconds as number))
    : null;

  let maxObservedGapSeconds: number | null = null;
  for (let i = 1; i < rows.length; i++) {
    const gap = (Date.parse(rows[i].captured_at) - Date.parse(rows[i - 1].captured_at)) / 1000;
    if (maxObservedGapSeconds === null || gap > maxObservedGapSeconds) maxObservedGapSeconds = gap;
  }

  return { intervalKnown, maxIntervalSeconds, maxObservedGapSeconds, sampleCount: rows.length };
}

const DEFAULT_RETENTION_DAYS = 7;

/**
 * Prune snapshots older than the retention window for one tenant. Called by
 * the sampling cron after each tenant's run (see
 * src/app/api/cron/sample-equity) rather than a separate scheduled job —
 * this table is write-heavy and only useful for a bounded lookback (see the
 * migration's retention note), so piggy-backing the prune onto the job that
 * already touches this tenant avoids standing up a second cron for it.
 */
export async function pruneSnapshots(
  tenantId: string,
  retentionDays: number = DEFAULT_RETENTION_DAYS
): Promise<boolean> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const db = tenantDb(tenantId, 'pruneSnapshots');
  // `tenantDb().delete()` doesn't request a row count back (see
  // src/lib/db/tenant-scoped.ts), and asking for one here would mean a
  // second round trip just to log a number nobody acts on — the prune
  // either succeeded or it logged why not.
  const { error } = await db.delete('equity_snapshots').lt('captured_at', cutoff);

  if (error) {
    logError('pruneSnapshots: delete failed', error, { category: 'database', tenant_id: tenantId });
    return false;
  }
  return true;
}

/**
 * Resolve push-path `account_login`s to internal `accounts.id`s within one
 * tenant. Logins that don't match any account in this tenant are reported,
 * not silently dropped — mirrors ingest-trades' `unresolvedTenant` counter.
 */
export async function resolveAccountIdsByLogin(
  tenantId: string,
  logins: string[]
): Promise<{ byLogin: Map<string, string>; unresolved: string[] }> {
  const unique = [...new Set(logins)];
  if (unique.length === 0) return { byLogin: new Map(), unresolved: [] };

  const db = tenantDb(tenantId, 'resolveAccountIdsByLogin');
  const { data, error } = await db
    .select('accounts', 'id, login')
    .in('login', unique)
    .returns<{ id: string; login: string }[]>();
  if (error) throw error;

  const byLogin = new Map((data ?? []).map((a) => [a.login, a.id]));
  const unresolved = unique.filter((l) => !byLogin.has(l));
  return { byLogin, unresolved };
}

export function inputsFromPush(
  tenantId: string,
  accountIdByLogin: Map<string, string>,
  snapshots: PushSnapshotInput[]
): SnapshotWriteInput[] {
  const out: SnapshotWriteInput[] = [];
  for (const s of snapshots) {
    const accountId = accountIdByLogin.get(s.account_login);
    if (!accountId) continue;
    out.push({
      accountId,
      capturedAt: new Date(s.captured_at).toISOString(),
      balance: s.balance,
      equity: s.equity,
      openPnl: s.open_pnl ?? null,
      source: 'push',
      sampleIntervalSeconds: s.sample_interval_seconds ?? null,
    });
  }
  return out;
}
