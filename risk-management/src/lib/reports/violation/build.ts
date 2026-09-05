import { createHash } from 'crypto';
import { brand } from '@/config/brand';
import { logAuditEvent } from '@/lib/audit/chain';
import { tenantDb } from '@/lib/db/tenant-scoped';
import { violationLabel } from '@/lib/violations/labels';
import { describeThreshold, type BreachEvidence } from '@/lib/rulepack/types';
import type { AccountContext } from '@/lib/rulepack/types';
import type { Threshold } from '@/lib/rulepack/schema';
import {
  COPY_TRADING_CONFIG,
  FUTURES_CONFIG,
  GRID_TRADING_CONFIG,
  HFT_THRESHOLDS,
  LOT_LIMITS,
  MARTINGALE_CONFIG,
  NEWS_WINDOW_MINUTES,
} from '@/config/violations';
import {
  NARRATIVE_DISCLAIMER,
  VIOLATION_REPORT_SCHEMA_VERSION,
  type ReportRuleSource,
  type ReportTimelineKind,
  type ViolationReport,
  type ViolationReportRecord,
} from './types';

/**
 * Assembles the per-violation decision record and persists it once per
 * distinct content (00025_violation_reports.sql explains why the payload is
 * stored rather than rebuilt).
 *
 * Two rules this module does not bend:
 *
 *  1. **No LLM anywhere.** `arithmetic` lines are deterministic strings built
 *     from stored numbers. Any generated prose that exists (an evidence pack's
 *     `narrative`) is copied into `provenance.generatedNarrative` behind a
 *     disclaimer and never contributes a figure.
 *  2. **The rule is quoted, not recomputed.** For a rule-pack finding the
 *     limit/observed/math sentences come from the `BreachEvidence` the
 *     evaluator wrote AT DECISION TIME. Re-deriving them from today's pack
 *     would re-state an old breach against a rule that may since have moved.
 *
 * Reads go through a `ReportDb` so the same assembly runs under RLS from an
 * operator route (`requestScopedReportDb(createClient(), tenantId)`) and under
 * `tenantDb()` from the trader route, which has no session to key RLS off.
 */

// ---------------------------------------------------------------------------
// Database surface
// ---------------------------------------------------------------------------

/**
 * The minimal read/write surface this module needs. `tenantDb(tenantId)`
 * already satisfies it; `requestScopedReportDb` adapts an RLS-constrained
 * request client to the same shape so there is exactly one assembly path.
 */
export interface ReportDb {
  tenantId: string;
  from(table: string): any;
  insert(table: string, rows: Record<string, unknown> | Record<string, unknown>[]): any;
  update(table: string, patch: Record<string, unknown>): any;
}

interface SupabaseLike {
  from(table: string): any;
}

/**
 * Wrap the request-scoped Supabase client (RLS applies, because it carries the
 * caller's session) in the `ReportDb` shape. The explicit `tenant_id` filter is
 * belt-and-braces: the policy already constrains it, and a route that somehow
 * ran without a tenant claim would return nothing rather than everything.
 */
export function requestScopedReportDb(client: SupabaseLike, tenantId: string): ReportDb {
  return {
    tenantId,
    from: (table: string) => client.from(table).select('*').eq('tenant_id', tenantId),
    insert: (table: string, rows: Record<string, unknown> | Record<string, unknown>[]) =>
      client
        .from(table)
        .insert((Array.isArray(rows) ? rows : [rows]).map((row) => ({ ...row, tenant_id: tenantId }))),
    update: (table: string, patch: Record<string, unknown>) => {
      const { tenant_id: _discarded, ...safe } = patch;
      return client.from(table).update(safe).eq('tenant_id', tenantId);
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic formatting + canonical hashing
// ---------------------------------------------------------------------------

/**
 * Money as a plain string. Deliberately NOT `Intl.NumberFormat` (which
 * `formatCurrency` uses): ICU output varies between Node builds, and a report
 * whose bytes change with the runtime cannot be hashed for idempotency.
 */
export function usd(amount: number): string {
  const n = Number.isFinite(amount) ? amount : 0;
  const sign = n < 0 ? '-' : '';
  const [whole, fraction] = Math.abs(n).toFixed(2).split('.');
  return `${sign}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Recursively key-sorted JSON with `undefined` dropped. The hash input. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, val]) => val !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, sort(val)])
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * sha256 over the report WITHOUT its own identity fields. Two runs that see
 * the same facts produce the same hash even though they mint a different
 * report id at a different instant — which is what makes the write idempotent
 * by input rather than by wall clock.
 */
export function contentHashOf(report: ViolationReport): string {
  const { reportId: _id, generatedAt: _at, generatedBy: _by, ...facts } = report;
  return createHash('sha256').update(canonicalJson(facts)).digest('hex');
}

// ---------------------------------------------------------------------------
// Rule phrasing
// ---------------------------------------------------------------------------

/**
 * The limit sentence for a legacy-engine finding, derived from the thresholds
 * the legacy detectors actually use (`src/config/violations.ts`). These are
 * code constants rather than a versioned pack, so the sentence says which
 * configuration produced it — a reader months later needs to know the limit
 * was not read from a pinned rule pack.
 */
export function legacyLimitSentence(
  typeKey: string,
  ctx: { accountSize?: number; assetClass?: string }
): string {
  switch (typeKey) {
    case 'hft': {
      const windows = HFT_THRESHOLDS.map(
        (w) => `${w.max_trades} trades in ${w.window_seconds}s`
      ).join('; ');
      return `No more than ${windows} (sliding windows).`;
    }
    case 'overleveraging': {
      const size = ctx.accountSize as keyof typeof LOT_LIMITS | undefined;
      const row = size !== undefined ? LOT_LIMITS[size] : undefined;
      const cls = ctx.assetClass as keyof typeof LOT_LIMITS[keyof typeof LOT_LIMITS] | undefined;
      const limit = row && cls ? row[cls] : undefined;
      if (limit === undefined) {
        return 'Position size capped per account size and instrument class (src/config/violations.ts LOT_LIMITS).';
      }
      return `Maximum ${limit} lots on ${String(cls)} for a ${usd(Number(size))} account.`;
    }
    case 'news':
      return `No positions opened within ${NEWS_WINDOW_MINUTES} minutes of a high-impact news release.`;
    case 'martingale':
      return (
        `Position size may not increase by more than ` +
        `${MARTINGALE_CONFIG.flipping_volume_multiplier}x after ` +
        `${MARTINGALE_CONFIG.min_losing_trades} or more consecutive losing trades.`
      );
    case 'grid':
      return (
        `No ${GRID_TRADING_CONFIG.min_mirrored_trades}+ mirrored trades within ` +
        `${GRID_TRADING_CONFIG.time_window_seconds}s at a lot-size tolerance of ` +
        `${(GRID_TRADING_CONFIG.lot_size_tolerance * 100).toFixed(0)}% ` +
        `(similarity score threshold ${GRID_TRADING_CONFIG.score_threshold}).`
      );
    case 'copy':
      return (
        `No ${COPY_TRADING_CONFIG.min_copied_trades}+ trades mirroring another account within ` +
        `${COPY_TRADING_CONFIG.lag_window_seconds}s at a lot-size tolerance of ` +
        `${(COPY_TRADING_CONFIG.lot_size_tolerance * 100).toFixed(0)}% ` +
        `(similarity score threshold ${COPY_TRADING_CONFIG.score_threshold}).`
      );
    case 'daily_loss':
      return `Maximum daily loss of ${(FUTURES_CONFIG.default_max_daily_loss_pct * 100).toFixed(2)}% of the starting balance.`;
    case 'trailing_drawdown':
      return `Maximum trailing peak-to-trough equity drawdown of ${(FUTURES_CONFIG.default_max_trailing_drawdown_pct * 100).toFixed(2)}%.`;
    case 'position_limit': {
      const limit = ctx.accountSize
        ? FUTURES_CONFIG.position_limits_by_size[ctx.accountSize]
        : undefined;
      return limit === undefined
        ? 'Maximum concurrent contracts capped per account size (src/config/violations.ts FUTURES_CONFIG).'
        : `Maximum ${limit} concurrent contracts for a ${usd(ctx.accountSize as number)} account.`;
    }
    case 'eod_flat':
      return `All positions flat by ${String(FUTURES_CONFIG.eod_flat_hour_utc).padStart(2, '0')}:00 UTC.`;
    case 'overnight':
      return 'Positions may not be held through the session close.';
    default:
      return 'Limit not recorded on this violation; see the detection engine configuration in effect at the time.';
  }
}

/** True when the object looks like a `Threshold` the pack schema would accept. */
function isThreshold(value: unknown): value is Threshold {
  if (!value || typeof value !== 'object') return false;
  const t = value as { type?: unknown; value?: unknown };
  return (
    (t.type === 'fixed' || t.type === 'pct_of_initial' || t.type === 'pct_of_current') &&
    typeof t.value === 'number'
  );
}

// ---------------------------------------------------------------------------
// Source rows
// ---------------------------------------------------------------------------

/**
 * Everything the assembler is allowed to look at. Passing rows in (rather than
 * querying inside the assembler) keeps `assembleViolationReport` a pure
 * function, which is what makes the hash reproducible and the tests real.
 */
export interface ViolationReportSources {
  violation: Record<string, any>;
  account: Record<string, any> | null;
  trades: Array<Record<string, any>>;
  deductions: Array<Record<string, any>>;
  emails: Array<Record<string, any>>;
  queueEntry: Record<string, any> | null;
  breachDecision: Record<string, any> | null;
  evidencePack: Record<string, any> | null;
  rulePack: Record<string, any> | null;
  priorViolations: Array<Record<string, any>>;
  disputes: Array<Record<string, any>>;
  snapshots: Array<Record<string, any>>;
}

/**
 * `violations.details_json`, in every shape this codebase has produced.
 *
 * The current writer is `src/lib/violations/record.ts` (owned by the detection
 * cron), which stamps `{ source, rule_pack_id, rule_pack_version,
 * rule_pack_content_hash, rule_id, action, evidence, idempotency_key,
 * breach_decision_id }` for rule-pack findings and `{ source: 'legacy_engine',
 * ... }` for legacy ones. Rows written before that exist and carry an
 * arbitrary detector-specific blob, so every field here is optional and the
 * absence of `source` means "legacy" rather than "malformed".
 */
interface ViolationDetails {
  source?: string;
  rule_pack_id?: string;
  rule_pack_version?: number;
  rule_pack_content_hash?: string;
  rule_id?: string;
  action?: string;
  evidence?: Partial<BreachEvidence>;
  idempotency_key?: string;
  breach_decision_id?: string;
  [key: string]: unknown;
}

function readDetails(violation: Record<string, any>): ViolationDetails {
  const raw = violation.details_json;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as ViolationDetails;
}

/** UTC calendar day of an ISO timestamp, as `YYYY-MM-DD`. */
function utcDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Assembly (pure)
// ---------------------------------------------------------------------------

export interface AssembleOptions {
  reportId: string;
  generatedAt: string;
  generatedBy: string;
  firmName?: string;
}

/**
 * Turn the source rows into the report. Pure: same rows in, same bytes out.
 */
export function assembleViolationReport(
  sources: ViolationReportSources,
  opts: AssembleOptions
): ViolationReport {
  const v = sources.violation;
  const details = readDetails(v);
  const evidence = (details.evidence ?? {}) as Partial<BreachEvidence>;
  const decision = sources.breachDecision;
  const decisionEvidence = (decision?.evidence_json ?? {}) as Partial<BreachEvidence>;

  // The breach_decisions row is the richer copy of the same evidence; prefer
  // it when it is present, fall back to the copy stamped onto the violation.
  const ev: Partial<BreachEvidence> = {
    ...evidence,
    ...Object.fromEntries(Object.entries(decisionEvidence).filter(([, val]) => val !== undefined)),
  };

  const source: ReportRuleSource =
    details.source === 'rule_pack' || decision !== null ? 'rule_pack' : 'legacy_engine';

  const typeKey = String(v.violation_type ?? '');
  const ruleId = str(details.rule_id) ?? str(decision?.rule_id) ?? typeKey;

  const account = sources.account;
  const accountSize = num(v.account_size) ?? num(account?.account_size) ?? 0;
  const balance = num(account?.balance) ?? 0;
  const equity = num(account?.equity) ?? 0;

  // ── The rule, as written when it fired ────────────────────────────────────
  const packJson = (sources.rulePack?.pack_json ?? null) as Record<string, any> | null;
  const packRule = packJson?.rules?.[ruleId] as Record<string, any> | undefined;

  let limitAsWritten = str(ev.limit);
  if (!limitAsWritten && source === 'rule_pack' && isThreshold(packRule?.threshold)) {
    // Only reached when the evaluator recorded no limit sentence. Describing
    // the PINNED pack's threshold is still the rule as it stood at decision
    // time, because rule_packs rows are immutable once published.
    const ctx: AccountContext = {
      id: String(v.account_id ?? ''),
      login: String(account?.login ?? ''),
      phase: (account?.phase ?? 'funded') as AccountContext['phase'],
      startingBalance: accountSize,
      currentBalance: balance,
      currentEquity: equity,
    };
    limitAsWritten = describeThreshold(packRule!.threshold as Threshold, ctx);
  }
  if (!limitAsWritten) {
    limitAsWritten = legacyLimitSentence(typeKey, {
      accountSize,
      assetClass: str(account?.asset_class) ?? str(v.asset_class),
    });
  }

  const packId = str(details.rule_pack_id) ?? str(decision?.rule_pack_id);
  const packVersion = num(details.rule_pack_version) ?? num(decision?.rule_pack_version);

  // ── What happened ─────────────────────────────────────────────────────────
  const detectedAt = String(v.detected_at ?? opts.generatedAt);
  const deductionAmount = num(v.deduction_amount) ?? 0;
  const exceededBy = num(ev.values?.exceededBy) ?? num(decision?.exceeded_by);
  const sessionDay = str(ev.sessionDay) ?? str(decision?.session_day);

  const observed =
    str(ev.observed) ??
    (deductionAmount > 0
      ? `${violationLabel(typeKey)} detected; ${usd(deductionAmount)} deduction recommended.`
      : `${violationLabel(typeKey)} detected.`);

  // ── The arithmetic ────────────────────────────────────────────────────────
  // Deterministic strings from stored numbers only. Never from prose.
  const arithmetic: ViolationReport['arithmetic'] = [];
  if (str(ev.math)) {
    arithmetic.push({ label: 'Breach arithmetic', expression: ev.math, value: '' });
  }
  for (const [key, value] of Object.entries(ev.values ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    if (value === null || value === undefined) continue;
    arithmetic.push({
      label: key,
      value: typeof value === 'number' ? (Number.isInteger(value) ? String(value) : value.toFixed(2)) : String(value),
    });
  }
  if (exceededBy !== undefined) {
    arithmetic.push({ label: 'Exceeded limit by', value: usd(exceededBy) });
  }
  if (deductionAmount > 0) {
    arithmetic.push({ label: 'Deduction recommended', value: usd(deductionAmount) });
  }
  const flaggedPnl = sources.trades.reduce((sum, t) => sum + (num(t.profit) ?? 0), 0);
  if (sources.trades.length > 0) {
    arithmetic.push({
      label: 'P&L across cited trades',
      expression: `${sources.trades.length} trade(s)`,
      value: usd(flaggedPnl),
    });
  }
  if (arithmetic.length === 0) {
    arithmetic.push({
      label: 'Arithmetic',
      value: 'Not recorded on this violation — see the detection engine output of the day.',
    });
  }

  // ── The trades ────────────────────────────────────────────────────────────
  const citedIds = new Set<string>([
    ...(Array.isArray(v.related_trade_ids) ? v.related_trade_ids.map(String) : []),
    ...(Array.isArray(ev.tradeIds) ? ev.tradeIds.map(String) : []),
  ]);

  const trades: ViolationReport['trades'] = sources.trades
    .map((t) => ({
      id: String(t.trade_id_external ?? t.id ?? ''),
      symbol: String(t.symbol ?? ''),
      side: String(t.direction ?? t.side ?? ''),
      volume: num(t.lot_size) ?? num(t.volume) ?? 0,
      openedAt: String(t.open_time ?? ''),
      closedAt: str(t.close_time),
      openPrice: num(t.open_price),
      closePrice: num(t.close_price),
      pnl: num(t.profit),
      flagged: citedIds.has(String(t.id)) || citedIds.has(String(t.trade_id_external)),
    }))
    .sort((a, b) => (a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : a.id < b.id ? -1 : 1));

  // ── The account, as it stood ──────────────────────────────────────────────
  const accountSnapshot: ViolationReport['accountSnapshot'] = {
    balance,
    equity,
    startingBalance: accountSize,
    startingDayBalance: num(account?.starting_day_balance),
    startingDayEquity: num(account?.starting_day_equity),
    drawdownFloor: num(ev.values?.drawdownFloor) ?? num(ev.values?.floor),
    netTransfers: num(account?.net_transfers),
  };

  // ── What the firm did ─────────────────────────────────────────────────────
  const queue = sources.queueEntry;
  const firstDeduction = sources.deductions[0] ?? null;

  const action: ViolationReport['action'] = {
    queueStatus: str(queue?.status),
    decision: str(queue?.status) ?? str(details.action) ?? str(decision?.action),
    approver: str(queue?.decided_by),
    decidedAt: str(queue?.decided_at),
    executedAt: str(queue?.executed_at) ?? str(firstDeduction?.executed_at),
    deduction: firstDeduction
      ? {
          amount: num(firstDeduction.amount) ?? 0,
          preBalance: num(firstDeduction.pre_balance),
          postBalance: num(firstDeduction.post_balance),
          executedBy: str(firstDeduction.executed_by),
        }
      : undefined,
  };

  // ── The timeline ──────────────────────────────────────────────────────────
  const timeline: ViolationReport['timeline'] = [];
  const push = (at: string | undefined, kind: ReportTimelineKind, summary: string, actor?: string) => {
    if (!at) return;
    timeline.push({ at, kind, summary, ...(actor ? { actor } : {}) });
  };

  for (const t of trades) {
    push(
      t.openedAt,
      'trade',
      `${t.side || 'trade'} ${t.volume} ${t.symbol}${t.flagged ? ' (cited)' : ''}`
    );
  }
  for (const s of sources.snapshots) {
    push(
      str(s.captured_at),
      'equity_sample',
      `equity ${usd(num(s.equity) ?? 0)} / balance ${usd(num(s.balance) ?? 0)}`
    );
  }
  push(detectedAt, 'detected', `${violationLabel(typeKey)} detected by the ${source === 'rule_pack' ? 'rule pack' : 'legacy engine'}`);
  push(str(queue?.created_at), 'queued', `Queued for review: ${str(queue?.action_type) ?? 'action'}`);
  push(str(queue?.decided_at), 'decided', `Queue ${str(queue?.status) ?? 'decided'}`, str(queue?.decided_by));
  push(str(queue?.executed_at), 'executed', 'Enforcement action executed');
  for (const e of sources.emails) {
    push(str(e.sent_at), 'notice_sent', `Notice sent: ${String(e.subject ?? '')}`, str(e.sent_by));
  }
  for (const d of sources.deductions) {
    push(
      str(d.executed_at),
      'deduction',
      `Deduction ${usd(num(d.amount) ?? 0)}: ${String(d.reason ?? '')}`,
      str(d.executed_by)
    );
  }
  for (const d of sources.disputes) {
    push(str(d.raised_at), 'dispute', `Dispute opened by ${String(d.raised_by ?? 'trader')}`, str(d.raised_by));
    push(str(d.resolved_at), 'dispute', `Dispute ${String(d.status ?? 'resolved')}`, str(d.resolved_by));
  }
  timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  // ── Provenance and fidelity ───────────────────────────────────────────────
  const dataFidelity: string[] = [];
  const day = sessionDay || utcDay(detectedAt);

  if (sources.snapshots.length === 0) {
    dataFidelity.push(
      `No equity snapshots retained for this session day${day ? ` (${day})` : ''} — intraday peaks cannot be reconstructed from the closed-trade tape.`
    );
  } else if (sources.snapshots.some((s) => s.sample_interval_seconds == null)) {
    dataFidelity.push(
      'Equity sampling interval unknown — intraday peaks may be missed.'
    );
  } else {
    const worst = Math.max(...sources.snapshots.map((s) => Number(s.sample_interval_seconds)));
    dataFidelity.push(
      `Equity sampled no finer than every ${worst}s — moves shorter than that are not observable.`
    );
  }

  if (source === 'rule_pack' && !decision) {
    dataFidelity.push(
      'The breach_decisions row for this finding was not found; the rule, limit and arithmetic are read from the copy stamped onto the violation.'
    );
  }
  if (source === 'legacy_engine') {
    dataFidelity.push(
      'Detected by the legacy engine, whose thresholds are code constants (src/config/violations.ts) rather than a versioned rule pack — the limit shown is the configuration in the deployed code, not a pinned snapshot.'
    );
  }
  if (!str(ev.limit) && !str(ev.observed) && !str(ev.math)) {
    dataFidelity.push(
      'This violation predates structured breach evidence; the rule and arithmetic sections are reconstructed from the columns available on the row.'
    );
  }
  if (!account) {
    dataFidelity.push('The account row for this violation could not be read; account figures are omitted rather than estimated.');
  }

  const narrative = str(sources.evidencePack?.narrative);

  const report: ViolationReport = {
    schemaVersion: VIOLATION_REPORT_SCHEMA_VERSION,
    reportId: opts.reportId,
    generatedAt: opts.generatedAt,
    generatedBy: opts.generatedBy,

    header: {
      firmName: opts.firmName ?? brand.companyName,
      accountId: String(v.account_id ?? ''),
      login: String(account?.login ?? v.account_id ?? ''),
      traderName: str(account?.trader_name),
      phase: str(v.phase) ?? str(account?.phase),
      assetClass: str(sources.rulePack?.asset_class) ?? str(sources.evidencePack?.asset_class),
      planName: str(v.challenge_type) ?? str(account?.challenge_type),
    },

    rule: {
      id: ruleId,
      label: violationLabel(typeKey),
      limitAsWritten,
      source,
      pack:
        packId && sources.rulePack
          ? {
              id: packId,
              name: String(sources.rulePack.name ?? ''),
              version: packVersion ?? num(sources.rulePack.version) ?? 0,
              contentHash: String(details.rule_pack_content_hash ?? sources.rulePack.content_hash ?? ''),
            }
          : undefined,
      action: str(details.action) ?? str(decision?.action),
    },

    whatHappened: {
      observed,
      exceededBy,
      sessionDay: sessionDay ? String(sessionDay) : undefined,
      severity: String(v.severity ?? 'medium'),
      detectedAt,
      status: String(v.status ?? 'detected'),
    },

    arithmetic,
    timeline,
    trades,
    accountSnapshot,
    action,

    history: {
      priorViolations: sources.priorViolations
        .map((p) => ({
          id: String(p.id),
          ruleLabel: violationLabel(String(p.violation_type ?? '')),
          detectedAt: String(p.detected_at ?? ''),
          status: String(p.status ?? ''),
        }))
        .sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0)),
      disputes: sources.disputes
        .map((d) => ({
          id: String(d.id),
          status: String(d.status ?? ''),
          openedAt: String(d.raised_at ?? d.created_at ?? ''),
          resolution: str(d.resolution),
        }))
        .sort((a, b) => (a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : 0)),
    },

    provenance: {
      dataFidelity,
      auditHash: undefined,
      evidencePackId: str(sources.evidencePack?.id),
      generatedNarrative: narrative
        ? { text: narrative, disclaimer: NARRATIVE_DISCLAIMER }
        : undefined,
      sourceRows: {
        violation: true,
        breachDecision: decision !== null,
        evidencePack: sources.evidencePack !== null,
        enforcementQueue: queue !== null,
      },
    },
  };

  return report;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function rowToRecord(row: Record<string, any>): ViolationReportRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    violationId: String(row.violation_id),
    accountId: String(row.account_id),
    subjectType: row.subject_type === 'breach_decision' ? 'breach_decision' : 'violation',
    report: row.report_json as ViolationReport,
    contentHash: String(row.content_hash),
    generatedBy: String(row.generated_by),
    generatedAt: String(row.generated_at),
    auditHash: row.audit_hash ?? null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Load every source row for one violation, in parallel. */
async function loadSources(
  db: ReportDb,
  violationId: string
): Promise<ViolationReportSources | null> {
  const { data: violationRow } = await db
    .from('violations')
    .eq('id', violationId)
    .maybeSingle();
  if (!violationRow) return null;

  const v = violationRow as Record<string, any>;
  const details = readDetails(v);
  const accountId = String(v.account_id ?? '');
  const detectedAt = String(v.detected_at ?? new Date(0).toISOString());
  const day = str(details.evidence?.sessionDay) ?? utcDay(detectedAt);
  const dayStart = day ? `${day}T00:00:00.000Z` : null;
  const dayEnd = day
    ? new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 86_400_000).toISOString()
    : null;

  const tradeIds = Array.from(
    new Set<string>([
      ...(Array.isArray(v.related_trade_ids) ? v.related_trade_ids.map(String) : []),
      ...(Array.isArray(details.evidence?.tradeIds) ? details.evidence!.tradeIds!.map(String) : []),
    ])
  ).filter((id) => UUID_RE.test(id));

  const [
    accountRes,
    tradesRes,
    deductionsRes,
    emailsRes,
    queueRes,
    decisionRes,
    packRes,
    priorRes,
    disputesRes,
    snapshotsRes,
  ] = await Promise.all([
    db.from('accounts').eq('id', accountId).maybeSingle(),
    tradeIds.length > 0
      ? db.from('trades').in('id', tradeIds)
      : Promise.resolve({ data: [] }),
    db.from('deductions').eq('violation_id', violationId).order('executed_at', { ascending: false }),
    db.from('emails').eq('violation_id', violationId).order('sent_at', { ascending: true }),
    db
      .from('enforcement_queue')
      .eq('violation_id', violationId)
      .order('created_at', { ascending: false })
      .limit(1),
    details.breach_decision_id && UUID_RE.test(details.breach_decision_id)
      ? db.from('breach_decisions').eq('id', details.breach_decision_id).maybeSingle()
      : Promise.resolve({ data: null }),
    details.rule_pack_id && UUID_RE.test(details.rule_pack_id)
      ? db.from('rule_packs').eq('id', details.rule_pack_id).maybeSingle()
      : Promise.resolve({ data: null }),
    db
      .from('violations')
      .eq('account_id', accountId)
      .neq('id', violationId)
      .order('detected_at', { ascending: false })
      .limit(20),
    db.from('disputes').eq('subject_id', violationId).order('raised_at', { ascending: true }),
    dayStart && dayEnd && UUID_RE.test(accountId)
      ? db
          .from('equity_snapshots')
          .eq('account_id', accountId)
          .gte('captured_at', dayStart)
          .lt('captured_at', dayEnd)
          .order('captured_at', { ascending: true })
          .limit(500)
      : Promise.resolve({ data: [] }),
  ]);

  // An evidence pack is keyed by (subject_type, subject_id) rather than by a
  // column on the violation, so it is looked up separately from the batch.
  const evidenceRes = await db
    .from('evidence_packs')
    .eq('subject_type', 'violation')
    .eq('subject_id', violationId)
    .order('created_at', { ascending: false })
    .limit(1);

  const list = (res: any): Array<Record<string, any>> => (Array.isArray(res?.data) ? res.data : []);
  const one = (res: any): Record<string, any> | null =>
    Array.isArray(res?.data) ? (res.data[0] ?? null) : (res?.data ?? null);

  return {
    violation: v,
    account: one(accountRes),
    trades: list(tradesRes),
    deductions: list(deductionsRes),
    emails: list(emailsRes),
    queueEntry: one(queueRes),
    breachDecision: one(decisionRes),
    evidencePack: one(evidenceRes),
    rulePack: one(packRes),
    priorViolations: list(priorRes),
    disputes: list(disputesRes),
    snapshots: list(snapshotsRes),
  };
}

export interface BuildViolationReportInput {
  tenantId: string;
  violationId: string;
  actor: string;
  /** Pass the RLS-constrained client from a route; defaults to `tenantDb`. */
  db?: ReportDb;
  /** Injected so the caller — and the tests — control the timestamp. */
  now?: Date;
  reportId?: string;
}

export interface BuildViolationReportResult {
  record: ViolationReportRecord;
  /** True when an identical-content row already existed and was reused. */
  unchanged: boolean;
}

export class ViolationNotFoundError extends Error {
  constructor(violationId: string) {
    super(`Violation ${violationId} not found for this tenant`);
    this.name = 'ViolationNotFoundError';
  }
}

/**
 * Build (or reuse) the persisted report for one violation.
 *
 * Idempotent by INPUT: the content hash covers the facts, not the rendering,
 * so calling this twice against unchanged data returns the same row rather
 * than a second near-identical one. It reports what it PERSISTED — the
 * returned record's `generatedAt` and `auditHash` come from the row, never
 * from what the call attempted (00024's lesson).
 */
export async function buildViolationReport(
  input: BuildViolationReportInput
): Promise<BuildViolationReportResult> {
  const db = input.db ?? tenantDb(input.tenantId, 'buildViolationReport');
  const sources = await loadSources(db, input.violationId);
  if (!sources) throw new ViolationNotFoundError(input.violationId);

  const generatedAt = (input.now ?? new Date()).toISOString();
  const reportId = input.reportId ?? deterministicReportId(input.tenantId, input.violationId, generatedAt);

  const report = assembleViolationReport(sources, {
    reportId,
    generatedAt,
    generatedBy: input.actor,
  });
  const contentHash = contentHashOf(report);

  const { data: existingRows } = await db
    .from('violation_reports')
    .eq('violation_id', input.violationId)
    .eq('content_hash', contentHash)
    .order('generated_at', { ascending: false })
    .limit(1);

  const existing = Array.isArray(existingRows) ? existingRows[0] : existingRows;
  if (existing) return { record: rowToRecord(existing), unchanged: true };

  const accountId = String(sources.violation.account_id ?? '');
  const { data: insertedRows, error } = await db
    .insert('violation_reports', {
      violation_id: input.violationId,
      account_id: accountId,
      subject_type: 'violation',
      report_json: { ...report, provenance: { ...report.provenance } },
      content_hash: contentHash,
      generated_by: input.actor,
      generated_at: generatedAt,
    })
    .select('*');

  if (error) {
    // A concurrent generator won the UNIQUE (tenant_id, violation_id,
    // content_hash) race. That is the idempotency guarantee working, not a
    // failure — re-read its row rather than reporting a write that did not
    // happen as a success.
    const { data: raced } = await db
      .from('violation_reports')
      .eq('violation_id', input.violationId)
      .eq('content_hash', contentHash)
      .limit(1);
    const racedRow = Array.isArray(raced) ? raced[0] : raced;
    if (racedRow) return { record: rowToRecord(racedRow), unchanged: true };
    throw error;
  }

  const insertedRow = Array.isArray(insertedRows) ? insertedRows[0] : insertedRows;
  if (!insertedRow) throw new Error('violation_reports insert returned no row');

  const auditHash = await logAuditEvent({
    action_type: 'violation_report_generated',
    entity_type: 'violation',
    entity_id: input.violationId,
    performed_by: input.actor,
    details: { report_id: insertedRow.id, content_hash: contentHash },
  });

  if (auditHash) {
    await db.update('violation_reports', { audit_hash: auditHash }).eq('id', insertedRow.id);
    insertedRow.audit_hash = auditHash;
  }

  const record = rowToRecord(insertedRow);
  // Keep the in-memory copy honest about what landed: the persisted
  // report_json carries no audit hash (it is computed from the row that
  // embeds it), so surface it on the returned object only.
  record.report = { ...record.report, provenance: { ...record.report.provenance, auditHash: auditHash ?? undefined } };
  return { record, unchanged: false };
}

/**
 * A report id that is stable for a given (tenant, violation, instant) rather
 * than random — `Math.random`/`randomUUID` in a report generator make two runs
 * of the same job produce different artefacts for identical facts.
 */
function deterministicReportId(tenantId: string, violationId: string, generatedAt: string): string {
  const h = createHash('sha256').update(`${tenantId}|${violationId}|${generatedAt}`).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), `4${h.slice(13, 16)}`, `8${h.slice(17, 20)}`, h.slice(20, 32)].join('-');
}

/**
 * The report as it should be RENDERED from a persisted row.
 *
 * `report_json` is written before the audit entry exists (the chain hashes the
 * row id, so the row must land first), which means the stored payload never
 * carries its own audit hash. The hash lives on the row; this folds it back in
 * at read time so a rendered PDF can cite the chain entry.
 */
export function reportOf(record: ViolationReportRecord): ViolationReport {
  if (!record.auditHash) return record.report;
  return {
    ...record.report,
    provenance: { ...record.report.provenance, auditHash: record.auditHash },
  };
}

/** The most recently generated report for one violation, or null. */
export async function getLatestViolationReport(
  tenantId: string,
  violationId: string,
  db?: ReportDb
): Promise<ViolationReportRecord | null> {
  const handle = db ?? tenantDb(tenantId, 'getLatestViolationReport');
  const { data, error } = await handle
    .from('violation_reports')
    .eq('violation_id', violationId)
    .order('generated_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row ? rowToRecord(row) : null;
}

/** Every report held for one account, newest first. */
export async function listViolationReportsForAccount(
  tenantId: string,
  accountId: string,
  db?: ReportDb
): Promise<ViolationReportRecord[]> {
  const handle = db ?? tenantDb(tenantId, 'listViolationReportsForAccount');
  const { data, error } = await handle
    .from('violation_reports')
    .eq('account_id', accountId)
    .order('generated_at', { ascending: false });
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map(rowToRecord);
}
