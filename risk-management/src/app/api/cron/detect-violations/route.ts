import { NextResponse } from 'next/server';
import {
  fetchAccountsToMonitor,
  fetchAccountDetails,
  fetchUserDetails,
} from '@/lib/platform/client';
import { runLocalViolationAnalysis } from '@/lib/payouts/local-analysis';
import { logAuditEvent } from '@/lib/deductions/audit';
import { cronMetrics, logError } from '@/lib/logging/logger';
import { tenantDb } from '@/lib/db/tenant-scoped';
import { buildEvidencePack } from '@/lib/evidence/builder';
import { draftTraderNotice } from '@/lib/alerts/notice';
import { notifyBreach } from '@/lib/notify/webhook';
import { fanOutToTenants } from '@/app/api/cron/_lib/fanout';
import { evaluateTenantLive, persistBreachDecisions } from '@/lib/rulepack/live';
import { sortDecisionsBySeverity } from '@/lib/rulepack/evaluate';
import { recordViolation, type RecordViolationResult } from '@/lib/violations/record';
import { violationLabel } from '@/lib/violations/labels';
import type { BreachAction } from '@/lib/rulepack/schema';
import type { BreachDecision } from '@/lib/rulepack/types';
import type { PlatformPayout } from '@/types/platform';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const CONCURRENCY = 5;

/** Cap on the `skipped` list carried back in the response, per tenant. */
const MAX_SKIPPED_REPORTED = 200;

/**
 * Futures first, then forex. `accounts` has no asset-class column — the split
 * exists only per (tenant, provider) on `connections` — so a tenant with an
 * active pack on BOTH classes cannot have its book split from `accounts` alone.
 * Evaluating every account twice under two different rulebooks would double
 * every decision, so the first pass claims the book and the second is told
 * which accounts it already covered. Same precedence `loadTraderView`
 * (src/lib/trader/data.ts) already uses, and the counts make the omission
 * visible rather than silent.
 */
const ASSET_CLASSES = ['futures', 'forex'] as const;
type AssetClass = (typeof ASSET_CLASSES)[number];

/**
 * `none_active`  — the tenant has no active pack for this class. NOT the same
 *                  as "no breaches": nothing was checked, and the response has
 *                  to be able to say so.
 * `evaluated`    — the pack ran against this tenant's book.
 */
type RulePackStatus = 'none_active' | 'evaluated';

interface SkippedRule {
  account_id: string;
  rule_id: string;
  reason: string;
}

interface TenantDetectionResult {
  total_detected: number;
  overleveraging: number;
  hft: number;
  martingale: number;
  news: number;
  grid: number;
  copy: number;
  enforcement_queued: number;
  errors: number;
  /** Whether a rule pack actually ran, per asset class. */
  rule_pack: Record<AssetClass, RulePackStatus>;
  accounts_evaluated: number;
  /** breach_decisions rows this run inserted. Rows, never attempts. */
  decisions_persisted: number;
  /** Decisions already on record — an identical re-run of the same inputs. */
  decisions_already_recorded: number;
  violations_created: number;
  violations_already_recorded: number;
  /** Every rule the engine could not evaluate, capped; see MAX_SKIPPED_REPORTED. */
  skipped: SkippedRule[];
  skipped_truncated: number;
}

function emptyResult(): TenantDetectionResult {
  return {
    total_detected: 0,
    overleveraging: 0,
    hft: 0,
    martingale: 0,
    news: 0,
    grid: 0,
    copy: 0,
    enforcement_queued: 0,
    errors: 0,
    rule_pack: { futures: 'none_active', forex: 'none_active' },
    accounts_evaluated: 0,
    decisions_persisted: 0,
    decisions_already_recorded: 0,
    violations_created: 0,
    violations_already_recorded: 0,
    skipped: [],
    skipped_truncated: 0,
  };
}

/**
 * A breach ACTION maps onto the enforcement queue's own vocabulary
 * (supabase/migrations 00009 / baseline: the action_type CHECK). The queue has
 * no 'terminate' or 'pause' member and inventing one would break the CHECK and
 * every consumer in src/lib/enforcement, so:
 *
 *   terminate / pause_trading → 'account_restriction'  (restrict the account)
 *   flag_for_review           → 'escalation'           (a human must look)
 *   warn                      → no queue row at all
 *
 * A warn is a record, not an action: it produces the breach decision and the
 * violation row so it is reportable and disputable, but nothing lands in a
 * human's queue, which is exactly what "warn" means in a rule pack.
 *
 * Note none of these is 'deduction'. A rule-pack breach decides an ACTION; what
 * it costs is a separate human decision, and `queue-manager.ts` only executes a
 * deduction for action_type 'deduction' — so this mapping cannot cause money to
 * move on its own.
 */
const QUEUE_ACTION_BY_BREACH: Record<BreachAction, string | null> = {
  terminate: 'account_restriction',
  pause_trading: 'account_restriction',
  flag_for_review: 'escalation',
  warn: null,
};

const QUEUE_SEVERITY_BY_BREACH: Record<
  BreachAction,
  { score: number; escalation: string }
> = {
  terminate: { score: 90, escalation: 'critical' },
  pause_trading: { score: 70, escalation: 'urgent' },
  flag_for_review: { score: 40, escalation: 'elevated' },
  warn: { score: 10, escalation: 'normal' },
};

/**
 * Runs violation detection for a single tenant.
 *
 * Two engines run, in this order:
 *
 *  1. The RULE PACK (src/lib/rulepack/*), against that tenant's active pack for
 *     each asset class. Every breach it decides is persisted to
 *     `breach_decisions` and given a `violations` row, so every enforcement item
 *     is backed by a decision record with the arithmetic, the trades and the
 *     pack version that produced it.
 *  2. The LEGACY per-trade detectors, unchanged in what they detect, but now
 *     routed through the same `recordViolation` so their findings also leave a
 *     `violations` row instead of going straight to the queue.
 *
 * Both paths dedup on an INPUT-derived idempotency key rather than on a clock
 * window. The six-hour window this replaced answered differently depending on
 * when the cron happened to fire, which made a run impossible to replay — and
 * replay is the whole basis of a defensible breach decision.
 *
 * Nothing here executes an action. Queue rows land 'pending', which is the
 * existing human-approval surface (src/lib/enforcement/*).
 */
async function detectForTenant(tenantId: string, now: string): Promise<TenantDetectionResult> {
  const results = emptyResult();
  const db = tenantDb(tenantId, 'detect-violations');

  await runRulePackPass(tenantId, db, now, results);
  await runLegacyPass(tenantId, db, now, results);

  return results;
}

function addSkipped(results: TenantDetectionResult, entry: SkippedRule): void {
  if (results.skipped.length < MAX_SKIPPED_REPORTED) results.skipped.push(entry);
  else results.skipped_truncated++;
}

// ---------------------------------------------------------------------------
// 1. Rule-pack path
// ---------------------------------------------------------------------------

async function runRulePackPass(
  tenantId: string,
  db: ReturnType<typeof tenantDb>,
  now: string,
  results: TenantDetectionResult
): Promise<void> {
  const alreadyEvaluated = new Set<string>();

  for (const assetClass of ASSET_CLASSES) {
    const live = await evaluateTenantLive({
      tenantId,
      assetClass,
      now,
      excludeAccountIds: alreadyEvaluated,
    });

    if (!live.pack) {
      // Left as 'none_active'. Reporting zero breaches for a tenant that has no
      // rulebook would read as "clean" for an account book nobody checked.
      continue;
    }

    results.rule_pack[assetClass] = 'evaluated';
    results.accounts_evaluated += live.results.length;

    const decisions: BreachDecision[] = [];
    for (const account of live.results) {
      alreadyEvaluated.add(account.accountId);
      decisions.push(...account.decisions);
      for (const s of account.skipped) {
        addSkipped(results, {
          account_id: account.accountId,
          rule_id: s.ruleId,
          reason: s.reason,
        });
      }
    }

    // Persist EVERY decision, including indeterminate ones: "this rule could not
    // be evaluated for this account" is a fact worth keeping.
    const persisted = await persistBreachDecisions(tenantId, live.pack, decisions);
    results.decisions_persisted += persisted.inserted;
    results.decisions_already_recorded += persisted.alreadyRecorded;

    // Only decisions that actually fired become violations and queue items. An
    // indeterminate decision records that a rule could NOT be evaluated — it is
    // not a breach and must never enforce.
    const actionable = sortDecisionsBySeverity(decisions).filter((d) => !d.indeterminate);
    const loginByAccount = new Map(live.results.map((r) => [r.accountId, r.login]));

    for (const decision of actionable) {
      results.total_detected++;

      let recorded: RecordViolationResult;
      try {
        recorded = await recordViolation(db, {
          accountKey: decision.accountId,
          finding: {
            source: 'rule_pack',
            ruleId: decision.ruleId,
            action: decision.action,
            exceededBy: decision.exceededBy,
            evidence: decision.evidence,
            idempotencyKey: decision.idempotencyKey,
            breachDecisionId: persisted.idByKey.get(decision.idempotencyKey) ?? null,
            rulePackId: live.pack.id,
            rulePackVersion: live.pack.version,
            rulePackContentHash: live.pack.contentHash,
          },
        });
      } catch (err) {
        logError('recordViolation threw for a rule-pack decision', err, {
          category: 'database',
          tenant_id: tenantId,
          account_id: decision.accountId,
          violation_type: decision.ruleId,
        });
        results.errors++;
        continue;
      }

      if (!recorded.violationId) {
        logError('Rule-pack breach could not be recorded as a violation', recorded.reason, {
          category: 'database',
          tenant_id: tenantId,
          account_id: decision.accountId,
          violation_type: decision.ruleId,
        });
        results.errors++;
        continue;
      }

      if (recorded.created) results.violations_created++;
      else results.violations_already_recorded++;

      const queueAction = QUEUE_ACTION_BY_BREACH[decision.action];
      // A 'warn' is deliberately record-only: it leaves a decision and a
      // violation so it is reportable and disputable, but nothing reaches a
      // human's queue.
      if (!queueAction) continue;

      // A violation this run created cannot already be queued — the violation
      // row is the anchor and it is written first. Only a repeat run (or one
      // that failed after the violation and before the queue row) needs asking.
      if (!recorded.created) {
        const queued = await existingQueuedViolationIds(db, [recorded.violationId]);
        if (queued.has(recorded.violationId)) continue;
      }

      await queueRulePackDecision({
        db,
        tenantId,
        now,
        decision,
        queueAction,
        violationId: recorded.violationId,
        accountId: recorded.accountId ?? decision.accountId,
        breachDecisionId: persisted.idByKey.get(decision.idempotencyKey) ?? null,
        login: loginByAccount.get(decision.accountId) ?? '',
        pack: live.pack,
        results,
      });
    }
  }
}

/**
 * Which of these violations already have a queue row. This is the dedup, and it
 * replaces the six-hour clock window entirely.
 *
 * It is a dedup BY IDEMPOTENCY KEY with one level of indirection: a violation
 * row exists at most once per key (uq_violations_idempotency, migration 00026),
 * so "a queue row points at this violation" and "a queue row already carries
 * this decision's key" are the same statement. The key is written into
 * `recommendation_details.idempotency_key` for reporting, but the lookup goes
 * through `enforcement_queue.violation_id` — a plain indexed uuid column rather
 * than a JSONB path filter, which keeps the dedup query trivial and exact.
 *
 * No status filter and no time bound: once a decision has been queued it is not
 * queued again, whatever a human later did with it. Re-detecting the same tape
 * must be a no-op forever, not for six hours.
 */
async function existingQueuedViolationIds(
  db: ReturnType<typeof tenantDb>,
  violationIds: string[]
): Promise<Set<string>> {
  const found = new Set<string>();
  if (violationIds.length === 0) return found;

  for (let i = 0; i < violationIds.length; i += 200) {
    const { data, error } = await db
      .select('enforcement_queue', 'violation_id')
      .in('violation_id', violationIds.slice(i, i + 200))
      .returns<{ violation_id: string | null }[]>();
    if (error) throw error;
    for (const row of data ?? []) {
      if (row.violation_id) found.add(row.violation_id);
    }
  }

  return found;
}

async function queueRulePackDecision(args: {
  db: ReturnType<typeof tenantDb>;
  tenantId: string;
  now: string;
  decision: BreachDecision;
  queueAction: string;
  violationId: string;
  accountId: string;
  breachDecisionId: string | null;
  login: string;
  pack: { id: string; version: number };
  results: TenantDetectionResult;
}): Promise<void> {
  const {
    db,
    tenantId,
    now,
    decision,
    queueAction,
    violationId,
    accountId,
    breachDecisionId,
    login,
    pack,
    results,
  } = args;

  const severity = QUEUE_SEVERITY_BY_BREACH[decision.action];
  const details = {
    source: 'rule_pack',
    idempotency_key: decision.idempotencyKey,
    violation_id: violationId,
    breach_decision_id: breachDecisionId,
    rule_pack_id: pack.id,
    rule_pack_version: pack.version,
    rule_id: decision.ruleId,
    breach_action: decision.action,
    session_day: decision.evidence.sessionDay ?? null,
    exceeded_by: decision.exceededBy,
    login,
  };

  try {
    const { data: inserted, error: insertError } = await db
      .insert('enforcement_queue', {
        account_id: accountId,
        violation_id: violationId,
        violation_type: decision.ruleId,
        action_type: queueAction,
        status: 'pending',
        severity_score: severity.score,
        escalation_level: severity.escalation,
        // A breach decides an action, not an amount. See QUEUE_ACTION_BY_BREACH.
        recommended_amount: 0,
        recommendation_reason: `${violationLabel(decision.ruleId)}: ${decision.evidence.observed} vs ${decision.evidence.limit}`,
        recommendation_details: details,
        prior_violation_count: 0,
        repeat_multiplier: 1,
        expires_at: new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString(),
      })
      .select('id')
      .single();

    if (insertError || !inserted) {
      logError('enforcement_queue insert failed (rule pack)', insertError, {
        category: 'database',
        tenant_id: tenantId,
        account_id: accountId,
        violation_type: decision.ruleId,
      });
      results.errors++;
      return;
    }

    results.enforcement_queued++;

    const queueId = (inserted as unknown as { id: string }).id;
    await attachEvidence({
      db,
      tenantId,
      queueId,
      violationId,
      accountId,
      violationType: decision.ruleId,
      details,
    });

    await notifyBreach({
      tenantId,
      accountId,
      violationType: decision.ruleId,
      severity: severity.escalation,
      amount: decision.exceededBy ?? 0,
      summary: `${violationLabel(decision.ruleId)} — ${decision.evidence.observed}`,
      enforcementQueueId: queueId,
      violationId,
    });
  } catch (err) {
    logError('enforcement_queue insert threw (rule pack)', err, {
      category: 'database',
      tenant_id: tenantId,
      account_id: accountId,
      violation_type: decision.ruleId,
    });
    results.errors++;
  }
}

/**
 * Automated evidence pack + drafted trader notice, queued for human approval —
 * never sent. Best-effort: a failure here must not roll back the
 * enforcement_queue row that already exists.
 *
 * Keyed by `subjectType: 'violation'` now that the row exists. The predecessor
 * keyed by 'account' because this path never created one, so a violation-keyed
 * pack would have looked up an id that did not exist and come back empty.
 * `accountId` is still passed because the builder's violation branch resolves
 * the account-scoped sections (deductions, prior decisions, audit history) from
 * it rather than from the violation row.
 */
async function attachEvidence(args: {
  db: ReturnType<typeof tenantDb>;
  tenantId: string;
  queueId: string;
  violationId: string;
  accountId: string;
  violationType: string;
  details: Record<string, unknown>;
}): Promise<void> {
  const { db, tenantId, queueId, violationId, accountId, violationType, details } = args;

  try {
    const pack = await buildEvidencePack({
      subjectType: 'violation',
      subjectId: violationId,
      accountId,
      tenantId,
    });
    const notice = draftTraderNotice(pack);

    await db
      .update('enforcement_queue', {
        recommendation_details: {
          ...details,
          evidence_pack_id: pack.id,
          notice_draft: notice,
        },
      })
      .eq('id', queueId);
  } catch (evidenceErr) {
    logError('Evidence pack / notice draft failed (non-blocking)', evidenceErr, {
      category: 'internal',
      tenant_id: tenantId,
      account_id: accountId,
      violation_type: violationType,
    });
  }
}

// ---------------------------------------------------------------------------
// 2. Legacy detector path
// ---------------------------------------------------------------------------

async function runLegacyPass(
  tenantId: string,
  db: ReturnType<typeof tenantDb>,
  now: string,
  results: TenantDetectionResult
): Promise<void> {
  // Accounts to scan: pending payouts (payout-queue providers) or the full
  // account book (trading platforms with no payout queue), scoped to this
  // tenant's configured provider connection.
  const payouts = await fetchAccountsToMonitor(tenantId);

  const uniqueAccounts = new Map<string, PlatformPayout>();
  for (const p of payouts) {
    if (p.accountId && !uniqueAccounts.has(p.accountId)) {
      uniqueAccounts.set(p.accountId, p);
    }
  }

  const accounts = Array.from(uniqueAccounts.values());
  if (accounts.length === 0) return;

  for (let i = 0; i < accounts.length; i += CONCURRENCY) {
    const batch = accounts.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (payout) => {
        const accountId = payout.accountId.toString();

        const [accountDetails, userDetails] = await Promise.all([
          fetchAccountDetails(accountId, tenantId),
          payout.userId ? fetchUserDetails(payout.userId, tenantId) : Promise.resolve(null),
        ]);

        const email = payout.email || userDetails?.email || '';

        const localResult = await runLocalViolationAnalysis({
          accountId,
          email,
          startingBalance: accountDetails?.startingBalance || 0,
          priorDayBalance: accountDetails?.priorDayBalance,
          priorDayEquity: accountDetails?.priorDayEquity,
          planName: accountDetails?.planName || payout.plan || '',
          tenantId,
        });

        return { payout, accountDetails, userDetails, localResult, email };
      })
    );

    for (const r of batchResults) {
      if (r.status !== 'fulfilled') {
        results.errors++;
        continue;
      }

      const { payout, accountDetails, userDetails, localResult, email } = r.value;
      const mergedBreakdown = localResult.mergedBreakdown;
      if (Object.keys(mergedBreakdown).length === 0) continue;

      const accountId = payout.accountId.toString();
      const login = payout.login?.toString() || accountDetails?.login?.toString() || '';
      const plan = accountDetails?.planName || payout.plan || '';
      const startingBalance = accountDetails?.startingBalance || 0;
      const flaggedTradeCount = localResult.localAnalysis.summary.violatingTradeCount;

      for (const [violationType, amount] of Object.entries(mergedBreakdown)) {
        if (amount <= 0) continue;

        results.total_detected++;
        if (violationType in results) {
          (results as unknown as Record<string, number>)[violationType] =
            ((results as unknown as Record<string, number>)[violationType] || 0) + 1;
        }

        // The trades this detector actually cited, as the platform ids them.
        // They are what makes the finding identifiable across runs.
        const platformTradeIds = Array.from(
          new Set(
            localResult.localAnalysis.violations
              .filter((v) => v.typeKey === violationType)
              .map((v) => v.trade._id)
          )
        );

        try {
          const recorded = await recordViolation(db, {
            accountKey: accountId,
            accountFallback: {
              login: login || accountId,
              email,
              traderName: userDetails
                ? `${userDetails.firstName ?? ''} ${userDetails.lastName ?? ''}`.trim() || null
                : null,
              startingBalance,
              userProfileId: payout.userId ? String(payout.userId) : accountId,
            },
            finding: {
              source: 'legacy_engine',
              violationType,
              amount,
              platformTradeIds,
              context: {
                login,
                plan,
                starting_balance: startingBalance,
                flagged_trade_count: flaggedTradeCount,
                detector: 'cron_platform',
              },
            },
          });

          if (!recorded.violationId) {
            logError('Legacy finding could not be recorded as a violation', recorded.reason, {
              category: 'database',
              tenant_id: tenantId,
              account_id: accountId,
              violation_type: violationType,
            });
            results.errors++;
            continue;
          }

          if (recorded.created) results.violations_created++;
          else results.violations_already_recorded++;

          if (!recorded.created) {
            const queued = await existingQueuedViolationIds(db, [recorded.violationId]);
            if (queued.has(recorded.violationId)) continue;
          }

          await queueLegacyFinding({
            db,
            tenantId,
            now,
            accountId: recorded.accountId ?? accountId,
            platformAccountId: accountId,
            violationType,
            amount,
            violationId: recorded.violationId,
            idempotencyKey: recorded.idempotencyKey,
            context: { login, plan, starting_balance: startingBalance, flagged_trade_count: flaggedTradeCount },
            results,
          });
        } catch (err) {
          logError('Legacy violation path threw', err, {
            category: 'database',
            tenant_id: tenantId,
            account_id: accountId,
            violation_type: violationType,
          });
          results.errors++;
        }
      }
    }
  }
}

async function queueLegacyFinding(args: {
  db: ReturnType<typeof tenantDb>;
  tenantId: string;
  now: string;
  accountId: string;
  platformAccountId: string;
  violationType: string;
  amount: number;
  violationId: string;
  idempotencyKey: string;
  context: Record<string, unknown>;
  results: TenantDetectionResult;
}): Promise<void> {
  const {
    db,
    tenantId,
    now,
    accountId,
    platformAccountId,
    violationType,
    amount,
    violationId,
    idempotencyKey,
    context,
    results,
  } = args;

  const severity = amount > 500 ? 30 : amount > 200 ? 25 : 15;
  const escalation = amount > 500 ? 'elevated' : 'normal';
  const details = {
    ...context,
    source: 'legacy_engine',
    idempotency_key: idempotencyKey,
    violation_id: violationId,
    platform_account_id: platformAccountId,
  };

  const { data: inserted, error: insertError } = await db
    .insert('enforcement_queue', {
      account_id: accountId,
      violation_id: violationId,
      violation_type: violationType,
      action_type: 'deduction',
      status: 'pending',
      severity_score: severity,
      escalation_level: escalation,
      recommended_amount: amount,
      recommendation_reason: `${violationType} deduction ($${amount.toFixed(2)})`,
      recommendation_details: details,
      prior_violation_count: 0,
      repeat_multiplier: 1,
      expires_at: new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    logError('enforcement_queue insert failed', insertError, {
      category: 'database',
      tenant_id: tenantId,
      account_id: accountId,
      violation_type: violationType,
    });
    results.errors++;
    return;
  }

  results.enforcement_queued++;

  const queueId = (inserted as unknown as { id: string }).id;
  await attachEvidence({
    db,
    tenantId,
    queueId,
    violationId,
    accountId,
    violationType,
    details,
  });

  // Notification fan-out (webhook + Slack) — fail-soft, never blocks detection.
  await notifyBreach({
    tenantId,
    accountId,
    violationType,
    severity: escalation,
    amount,
    summary: `${violationType} deduction ($${amount.toFixed(2)}) queued for review`,
    enforcementQueueId: queueId,
    violationId,
  });
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const NUMERIC_KEYS = [
  'total_detected',
  'overleveraging',
  'hft',
  'martingale',
  'news',
  'grid',
  'copy',
  'enforcement_queued',
  'errors',
  'accounts_evaluated',
  'decisions_persisted',
  'decisions_already_recorded',
  'violations_created',
  'violations_already_recorded',
  'skipped_truncated',
] as const;

type NumericKey = (typeof NUMERIC_KEYS)[number];

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startTime = Date.now();

  try {
    // One clock read for the whole run, threaded down as `now`. Every window,
    // expiry and evaluation instant derives from it, so a run is reproducible
    // from its inputs and its timestamp rather than from whenever each
    // individual line happened to execute.
    const now = new Date().toISOString();

    const outcomes = await fanOutToTenants((tenantId) => detectForTenant(tenantId, now), {
      jobName: 'detect-violations',
      concurrency: 3,
    });

    const totals = {} as Record<NumericKey, number>;
    for (const key of NUMERIC_KEYS) totals[key] = 0;

    const rulePackStatus: Record<AssetClass, Record<RulePackStatus, number>> = {
      futures: { none_active: 0, evaluated: 0 },
      forex: { none_active: 0, evaluated: 0 },
    };
    const skipped: SkippedRule[] = [];

    for (const o of outcomes) {
      if (!o.ok || !o.result) {
        totals.errors += 1;
        continue;
      }
      for (const key of NUMERIC_KEYS) totals[key] += o.result[key];
      for (const assetClass of ASSET_CLASSES) {
        rulePackStatus[assetClass][o.result.rule_pack[assetClass]] += 1;
      }
      for (const entry of o.result.skipped) {
        if (skipped.length < MAX_SKIPPED_REPORTED) skipped.push(entry);
        else totals.skipped_truncated += 1;
      }
    }

    const results = {
      ...totals,
      rule_pack: rulePackStatus,
      skipped,
      tenants: outcomes.map((o) => ({
        tenant_id: o.tenant_id,
        ok: o.ok,
        ...(o.ok ? o.result : { error: o.error }),
      })),
    };

    cronMetrics('detect-violations', startTime, {
      processed: totals.total_detected,
      errors: totals.errors,
      skipped: skipped.length + totals.skipped_truncated,
    });

    await logAuditEvent({
      action_type: 'cron_detect_violations',
      entity_type: 'system',
      entity_id: 'cron',
      performed_by: 'system',
      details: results,
    });

    return NextResponse.json({
      message: 'Violation detection complete',
      results,
    });
  } catch (error: any) {
    logError('Violation detection cron failed', error, {
      category: 'cron',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
