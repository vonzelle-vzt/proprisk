import { createHash } from 'crypto';
import type { tenantDb } from '@/lib/db/tenant-scoped';
import { logWarn } from '@/lib/logging/logger';
import type { BreachAction, RuleId } from '@/lib/rulepack/schema';
import type { BreachEvidence } from '@/lib/rulepack/types';

/**
 * The one place a `violations` row is created.
 *
 * Two engines produce findings — the rule pack (src/lib/rulepack/evaluate.ts)
 * and the legacy trade detectors (src/lib/payouts/local-analysis.ts) — and
 * before this module the live cron wrote neither: it inserted straight into
 * `enforcement_queue`, so an enforcement item had no decision record behind it
 * and its evidence pack had to be keyed by account instead of by the breach
 * that caused it. That is the "silent success" shape this codebase is prone to:
 * the job reports a number, and nothing durable stands behind it.
 *
 * So both engines come through here, and the row they produce carries enough
 * context in `details_json` to reconstruct the finding months later without the
 * code that made it: which engine, which pack version and content hash, the
 * full `BreachEvidence`, and the idempotency key.
 *
 * IDEMPOTENCY, and why there is no clock window here. Both engines key their
 * findings on their INPUTS: the rule pack on the evaluator's `idempotencyKey`
 * (pack version + account + rule + measured inputs), the legacy detectors on
 * `legacyFindingKey` below (account + type + the flagged trades + the amount).
 * Re-recording either is a no-op that returns the existing row's id. The
 * database enforces the same thing independently
 * (uq_violations_idempotency, supabase/migrations/00026), so two crons racing
 * cannot both win.
 *
 * The predecessor deduped on "did we queue this account+type in the last six
 * hours", which returns a different answer depending on when the job fired and
 * makes a run impossible to replay. An input-derived key gives the same answer
 * forever, and — unlike a window — a genuinely NEW occurrence (different
 * trades, a new pack version) is correctly a new decision rather than being
 * swallowed because the clock had not moved far enough.
 */

type TenantDb = ReturnType<typeof tenantDb>;

/** A breach the rule-pack engine decided. */
export interface RulePackFinding {
  source: 'rule_pack';
  ruleId: RuleId;
  action: BreachAction;
  exceededBy: number | null;
  evidence: BreachEvidence;
  /** Stable identity of the decision. Also the idempotency key of this row. */
  idempotencyKey: string;
  /** `breach_decisions.id` this violation is the enforcement face of. */
  breachDecisionId: string | null;
  rulePackId: string;
  rulePackVersion: number;
  rulePackContentHash: string;
}

/** A finding from the legacy per-trade detectors. */
export interface LegacyEngineFinding {
  source: 'legacy_engine';
  /** One of the seven legacy types; see the CHECK in migration 00026. */
  violationType: string;
  /** Recommended deduction, in account currency. */
  amount: number;
  /**
   * Trade ids as the PLATFORM reports them. Deliberately not written to
   * `violations.related_trade_ids`, which is `UUID[]` and references ingested
   * `trades` rows — a platform id is neither, and casting it would either throw
   * or, worse, land a bogus uuid that the evidence builder later joins on.
   */
  platformTradeIds?: string[];
  /** Extra context the cron already has (login, plan, starting balance). */
  context?: Record<string, unknown>;
}

/**
 * Stable identity of a legacy finding, so that path can be idempotent by input
 * like the rule-pack path is, rather than by a clock window.
 *
 * The inputs are exactly what makes the finding what it is: whose account, which
 * detector, which trades it cited, and what it computed. Re-detecting the same
 * trades yields the same key and records nothing new; a later run that flags an
 * ADDITIONAL trade is a different finding and correctly gets its own row.
 *
 * Namespaced so it can never collide with an evaluator key, which is bare hex.
 */
export function legacyFindingKey(
  accountKey: string,
  violationType: string,
  platformTradeIds: string[],
  amount: number
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        accountKey,
        violationType,
        tradeIds: [...platformTradeIds].sort(),
        amount: Number(amount.toFixed(2)),
      })
    )
    .digest('hex');
  return `legacy:${digest}`;
}

export type ViolationFinding = RulePackFinding | LegacyEngineFinding;

/**
 * Enough of the platform's own account record to synthesise a local `accounts`
 * row when one does not exist. See `resolveAccount`.
 */
export interface AccountFallback {
  login: string;
  email?: string | null;
  traderName?: string | null;
  /** The platform's starting balance. Snapped to a tier — see the note below. */
  startingBalance?: number | null;
  userProfileId?: string | null;
}

export interface RecordViolationInput {
  /**
   * `accounts.id` where the caller already has it (the rule-pack path loads
   * accounts from the table, so it always does). Otherwise a platform account
   * id or login, resolved against `accounts.login`.
   */
  accountKey: string;
  accountFallback?: AccountFallback;
  finding: ViolationFinding;
}

export interface RecordViolationResult {
  /** `violations.id`, or null when the row could not be written. */
  violationId: string | null;
  /** False when an identical finding was already recorded. */
  created: boolean;
  /** Resolved `accounts.id`. */
  accountId: string | null;
  /** True when this call had to synthesise the `accounts` row. */
  accountCreated: boolean;
  /** Input-derived identity of the finding; also stored in `details_json`. */
  idempotencyKey: string;
  /** Set when `violationId` is null: why nothing was written. */
  reason?: string;
}

/** `accounts.account_size` carries a CHECK constraint over exactly these. */
const ACCOUNT_SIZE_TIERS = [2500, 5000, 10000, 25000, 50000, 100000, 200000, 300000];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AccountRow {
  id: string;
  phase: string;
  challenge_type: string;
  account_size: number;
}

/** Severity of a rule-pack breach follows its action; both come from the pack. */
const SEVERITY_BY_ACTION: Record<BreachAction, 'low' | 'medium' | 'high' | 'critical'> = {
  terminate: 'critical',
  pause_trading: 'high',
  flag_for_review: 'medium',
  warn: 'low',
};

/** Legacy findings have no action, so severity keys off the deduction size —
 * the same thresholds src/lib/violations/worker.ts already uses. */
function legacySeverity(amount: number): 'low' | 'medium' | 'high' {
  return amount > 500 ? 'high' : amount > 100 ? 'medium' : 'low';
}

function nearestAccountSizeTier(balance: number): number {
  return ACCOUNT_SIZE_TIERS.reduce((best, tier) =>
    Math.abs(tier - balance) < Math.abs(best - balance) ? tier : best
  );
}

const ACCOUNT_COLUMNS = 'id, phase, challenge_type, account_size';

async function accountBy(
  db: TenantDb,
  column: string,
  value: string
): Promise<AccountRow | null> {
  // `tenantDb().select()` takes `table` as a bare `string`, so PostgREST cannot
  // resolve the literal-table overload it needs to infer a row shape from the
  // column list and falls back to `GenericStringError`; `.returns<T>()` restores
  // it (same pattern as src/lib/violations/worker.ts).
  const { data } = await db
    .select('accounts', ACCOUNT_COLUMNS)
    .eq(column, value)
    .limit(1)
    .returns<AccountRow[]>();
  return data && data.length > 0 ? data[0] : null;
}

/**
 * Find the local `accounts` row for a key that may be any of three things.
 *
 * The order matters, and every probe earns its place:
 *
 *  - `id`  — the rule-pack path evaluates accounts read out of this table, so
 *            its key IS `accounts.id`. Only attempted for a uuid.
 *  - `login` — the natural key a firm and its platform both use.
 *  - `user_profile_id` — where a synthesised row records the PLATFORM account
 *            id it was created from. Without this probe the legacy path would
 *            synthesise a row on its first run and then fail to find it on
 *            every subsequent run (the platform id is not the login), colliding
 *            with the (tenant_id, login) unique index and dropping the finding
 *            on the floor — a detected breach with no decision record, which is
 *            the exact failure this module exists to prevent.
 */
async function findAccount(
  db: TenantDb,
  accountKey: string,
  fallbackLogin?: string | null
): Promise<AccountRow | null> {
  if (UUID_RE.test(accountKey)) {
    const byId = await accountBy(db, 'id', accountKey);
    if (byId) return byId;
  }

  const byKeyLogin = await accountBy(db, 'login', accountKey);
  if (byKeyLogin) return byKeyLogin;

  if (fallbackLogin && fallbackLogin !== accountKey) {
    const byLogin = await accountBy(db, 'login', fallbackLogin);
    if (byLogin) return byLogin;
  }

  return accountBy(db, 'user_profile_id', accountKey);
}

/**
 * Resolve `violations.account_id`, which is a UUID FK to `accounts` — not the
 * platform's own account id, and not a login.
 *
 * The rule-pack path always hits the first branch: it evaluates accounts read
 * out of the `accounts` table, so `accountKey` IS `accounts.id`.
 *
 * The legacy cron path does not. It walks the provider's account book, so it
 * holds a platform id and a login for accounts that may never have been
 * ingested locally. Refusing to record those would mean a detected breach with
 * no decision record — the exact failure this module exists to remove — so a
 * minimal `accounts` row is synthesised from the platform details the cron
 * already fetched.
 *
 * Two fields in that row are approximations, and both are recorded as such in
 * the violation's `details_json` rather than passed off as ingested truth:
 *
 *  - `account_size` is constrained by a CHECK to eight fixed tiers, so a
 *    platform starting balance that is not one of them is snapped to the
 *    nearest tier. The true figure is kept as
 *    `details_json.account.platform_starting_balance`.
 *  - `challenge_type` and `phase` are not on the payout/monitoring payload at
 *    all; a monitored account is recorded as a funded 'pro' account, which is
 *    what the cron's account book actually contains.
 *
 * A synthesised row is flagged `details_json.account.synthesised = true` so a
 * report can tell it from an ingested one.
 */
async function resolveAccount(
  db: TenantDb,
  accountKey: string,
  fallback: AccountFallback | undefined
): Promise<{ account: AccountRow | null; created: boolean; approximations: Record<string, unknown> }> {
  const existing = await findAccount(db, accountKey, fallback?.login);
  if (existing) return { account: existing, created: false, approximations: {} };
  if (!fallback) return { account: null, created: false, approximations: {} };

  const platformBalance = Number(fallback.startingBalance ?? 0);
  const accountSize = nearestAccountSizeTier(platformBalance);

  const { data, error } = await db
    .insert('accounts', {
      login: fallback.login,
      user_profile_id: fallback.userProfileId ?? accountKey,
      account_size: accountSize,
      challenge_type: 'pro',
      phase: 'funded',
      balance: platformBalance,
      equity: platformBalance,
      email: fallback.email ?? '',
      trader_name: fallback.traderName ?? fallback.login,
      is_active: true,
    })
    .select('id, phase, challenge_type, account_size')
    .single();

  if (error || !data) {
    // Most likely a concurrent cron already created it — (tenant_id, login) is
    // unique under 00015. Re-read before giving up.
    const raced = await findAccount(db, accountKey, fallback.login);
    if (raced) return { account: raced, created: false, approximations: {} };

    logWarn('recordViolation: could not resolve or create the accounts row', {
      category: 'database',
      tenant_id: db.tenantId,
      account_id: accountKey,
      error: error?.message,
    });
    return { account: null, created: false, approximations: {} };
  }

  return {
    account: data as unknown as AccountRow,
    created: true,
    approximations: {
      synthesised: true,
      platform_account_id: accountKey,
      platform_starting_balance: platformBalance,
      account_size_snapped_to_tier: accountSize !== platformBalance,
    },
  };
}

/** The already-recorded violation for this finding, if any. */
async function findByIdempotencyKey(
  db: TenantDb,
  key: string
): Promise<{ id: string; account_id: string } | null> {
  const { data } = await db
    .select('violations', 'id, account_id')
    .eq('details_json->>idempotency_key', key)
    .limit(1)
    .returns<{ id: string; account_id: string }[]>();
  return data && data.length > 0 ? data[0] : null;
}

/** The input-derived identity of a finding, whichever engine produced it. */
function idempotencyKeyOf(accountKey: string, finding: ViolationFinding): string {
  return finding.source === 'rule_pack'
    ? finding.idempotencyKey
    : legacyFindingKey(
        accountKey,
        finding.violationType,
        finding.platformTradeIds ?? [],
        finding.amount
      );
}

/**
 * Create the `violations` row for one finding, from either engine.
 *
 * `db` is passed in rather than built here so the caller's tenant context and
 * its `tenantDb(tenantId, ctx)` label flow through unchanged.
 */
export async function recordViolation(
  db: TenantDb,
  input: RecordViolationInput
): Promise<RecordViolationResult> {
  const { finding } = input;
  const idempotencyKey = idempotencyKeyOf(input.accountKey, finding);

  // Idempotency first: a repeat run must not synthesise an accounts row, or
  // touch anything at all, before discovering it has nothing to do.
  const existing = await findByIdempotencyKey(db, idempotencyKey);
  if (existing) {
    return {
      violationId: existing.id,
      created: false,
      accountId: existing.account_id,
      accountCreated: false,
      idempotencyKey,
    };
  }

  const { account, created: accountCreated, approximations } = await resolveAccount(
    db,
    input.accountKey,
    input.accountFallback
  );

  if (!account) {
    return {
      violationId: null,
      created: false,
      accountId: null,
      accountCreated: false,
      idempotencyKey,
      reason: 'no accounts row could be resolved or created for this finding',
    };
  }

  const row =
    finding.source === 'rule_pack'
      ? rulePackRow(finding, account, approximations)
      : legacyRow(finding, account, input.accountKey, idempotencyKey, approximations);

  const { data, error } = await db.insert('violations', row).select('id').single();

  if (error || !data) {
    // 23505 on uq_violations_idempotency means a concurrent run recorded this
    // same finding between our check and our insert. That is the index doing
    // its job, not a failure: adopt the winner's row.
    const raced = await findByIdempotencyKey(db, idempotencyKey);
    if (raced) {
      return {
        violationId: raced.id,
        created: false,
        accountId: account.id,
        accountCreated,
        idempotencyKey,
      };
    }

    logWarn('recordViolation: violations insert failed', {
      category: 'database',
      tenant_id: db.tenantId,
      account_id: account.id,
      violation_type: row.violation_type as string,
      error: error?.message,
    });

    return {
      violationId: null,
      created: false,
      accountId: account.id,
      accountCreated,
      idempotencyKey,
      reason: error?.message ?? 'violations insert returned no row',
    };
  }

  return {
    violationId: (data as unknown as { id: string }).id,
    created: true,
    accountId: account.id,
    accountCreated,
    idempotencyKey,
  };
}

function rulePackRow(
  finding: RulePackFinding,
  account: AccountRow,
  approximations: Record<string, unknown>
): Record<string, unknown> {
  // `evidence.tradeIds` are `trades.id` values when the evaluation input came
  // from the ingested tape, but a synthetic input (the impact preview's
  // "current state" pseudo-trade, for one) can put a non-uuid in there. The
  // column is `UUID[]`, so anything that is not a uuid is kept in details_json
  // instead of breaking the insert.
  const tradeUuids = finding.evidence.tradeIds.filter((id) => UUID_RE.test(id));

  return {
    account_id: account.id,
    violation_type: finding.ruleId,
    status: 'detected',
    severity: SEVERITY_BY_ACTION[finding.action],
    details_json: {
      source: 'rule_pack',
      idempotency_key: finding.idempotencyKey,
      rule_id: finding.ruleId,
      action: finding.action,
      exceeded_by: finding.exceededBy,
      breach_decision_id: finding.breachDecisionId,
      rule_pack_id: finding.rulePackId,
      rule_pack_version: finding.rulePackVersion,
      rule_pack_content_hash: finding.rulePackContentHash,
      evidence: finding.evidence,
      /** Everything the engine cited, including ids that are not ingested trades. */
      cited_trade_ids: finding.evidence.tradeIds,
      ...(Object.keys(approximations).length > 0 ? { account: approximations } : {}),
    },
    related_trade_ids: tradeUuids,
    // A breach is not a deduction. The rule pack decides an ACTION
    // (terminate / pause / flag / warn); what it costs is a separate human
    // decision on the enforcement queue, so this stays 0 rather than inventing
    // a number that a payout would later net off.
    deduction_amount: 0,
    phase: account.phase,
    challenge_type: account.challenge_type,
    account_size: account.account_size,
  };
}

function legacyRow(
  finding: LegacyEngineFinding,
  account: AccountRow,
  accountKey: string,
  idempotencyKey: string,
  approximations: Record<string, unknown>
): Record<string, unknown> {
  return {
    account_id: account.id,
    violation_type: finding.violationType,
    status: 'detected',
    severity: legacySeverity(finding.amount),
    details_json: {
      source: 'legacy_engine',
      idempotency_key: idempotencyKey,
      violation_type: finding.violationType,
      amount: finding.amount,
      platform_account_id: accountKey,
      platform_trade_ids: finding.platformTradeIds ?? [],
      ...(finding.context ?? {}),
      ...(Object.keys(approximations).length > 0 ? { account: approximations } : {}),
    },
    related_trade_ids: [],
    deduction_amount: finding.amount,
    phase: account.phase,
    challenge_type: account.challenge_type,
    account_size: account.account_size,
  };
}
