import { randomUUID } from 'crypto';
import { tenantDb } from '@/lib/db/tenant-scoped';
import { logAuditEvent } from '@/lib/audit/chain';
import { buildEvidencePack } from '@/lib/evidence/builder';
import type { EvidenceSubjectType } from '@/lib/evidence/types';
import type { Dispute, DisputeStatus, DisputeSubjectType, OpenDisputeInput, ResolveDisputeInput, RuleOverturnRate } from './types';
import { TERMINAL_STATUSES } from './types';
import { violationLabel } from '@/lib/violations/labels';

/**
 * Dispute lifecycle (docs/HOW-IT-WORKS.md §6.4, task #4 of "what I would
 * build next"). Three moving pieces:
 *
 * 1. Opening a dispute pins the evidence pack that existed at DECISION time
 *    (`pinEvidencePack` below) — never a pack re-evaluated against whatever
 *    rule pack is active today. A dispute that silently re-scores under a
 *    newer rule pack is worthless as evidence.
 * 2. Every state change (open -> under_review -> upheld|overturned|withdrawn)
 *    joins the hash-chained audit log via `logAuditEvent`, naming the real
 *    human from the caller's guard result — never a hardcoded actor string
 *    (a real defect here once, per the build brief).
 * 3. Overturned is a real outcome: `computeOverturnRateByRule` is what a firm
 *    reads to see which of its own rules keeps producing decisions it later
 *    reverses.
 */

interface DisputeRow {
  id: string;
  tenant_id: string;
  subject_type: DisputeSubjectType;
  subject_id: string;
  account_id: string | null;
  raised_by: string;
  raised_at: string;
  trader_statement: string;
  status: DisputeStatus;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  evidence_pack_id: string | null;
  audit_hash: string | null;
  created_at: string;
  updated_at: string;
}

function rowToDispute(row: DisputeRow): Dispute {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    accountId: row.account_id,
    raisedBy: row.raised_by,
    raisedAt: row.raised_at,
    traderStatement: row.trader_statement,
    status: row.status,
    resolution: row.resolution,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    evidencePackId: row.evidence_pack_id,
    auditHash: row.audit_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** disputes.subject_type -> the evidence pack's subject_type vocabulary. */
const EVIDENCE_SUBJECT_TYPE: Record<DisputeSubjectType, EvidenceSubjectType> = {
  breach: 'violation',
  deduction: 'violation',
  payout: 'payout',
};

/**
 * Resolve the effective (evidenceSubjectType, evidenceSubjectId) to look up
 * or build a pack for. A 'deduction' dispute is filed against the deduction
 * row, but the evidence pack that documents WHY is keyed on the violation
 * that produced it — so a deduction dispute is pinned to its violation's pack.
 */
async function resolveEvidenceSubject(
  tenantId: string,
  subjectType: DisputeSubjectType,
  subjectId: string
): Promise<{ evidenceSubjectType: EvidenceSubjectType; evidenceSubjectId: string } | null> {
  if (subjectType !== 'deduction') {
    return { evidenceSubjectType: EVIDENCE_SUBJECT_TYPE[subjectType], evidenceSubjectId: subjectId };
  }

  const { data, error } = await tenantDb(tenantId, 'dispute deduction lookup')
    .from('deductions')
    .eq('id', subjectId)
    .maybeSingle();
  if (error || !data?.violation_id) return null;
  return { evidenceSubjectType: 'violation', evidenceSubjectId: data.violation_id as string };
}

/**
 * Pin the evidence pack at open time. Prefers an EXISTING pack for the
 * subject — the one assembled when the decision itself was made — over
 * building a fresh one, because a fresh build reflects today's rule
 * descriptions and thresholds, not the ones in force when the trader was
 * actually breached or paid out. Only builds a new pack when none exists yet
 * (e.g. a breach that never had one generated), and even then the pack is
 * built from the already-recorded violation/deduction rows in the database —
 * historical facts, not a live re-evaluation.
 */
async function pinEvidencePack(
  tenantId: string,
  subjectType: DisputeSubjectType,
  subjectId: string,
  accountId: string | null
): Promise<string | null> {
  const resolved = await resolveEvidenceSubject(tenantId, subjectType, subjectId);
  if (!resolved) return null;
  const { evidenceSubjectType, evidenceSubjectId } = resolved;

  const { data: existing } = await tenantDb(tenantId, 'dispute evidence lookup')
    .from('evidence_packs')
    .eq('subject_type', evidenceSubjectType)
    .eq('subject_id', evidenceSubjectId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (existing?.id) return existing.id as string;

  try {
    const pack = await buildEvidencePack({
      subjectType: evidenceSubjectType,
      subjectId: evidenceSubjectId,
      accountId,
      tenantId,
    });
    return pack.id || null;
  } catch {
    // Attaching evidence is best-effort at open time — a missing pack should
    // never block a trader's dispute from being recorded. evidence_pack_id
    // stays null and the queue UI reports the gap explicitly.
    return null;
  }
}

/** Append one audit entry for a dispute state change and store the resulting
 *  hash on the row, mirroring `payout_decisions.audit_hash`. */
async function appendDisputeAudit(
  tenantId: string,
  disputeId: string,
  actionType: string,
  actor: string,
  actorUserId: string,
  details: Record<string, unknown>
): Promise<string | null> {
  const hash = await logAuditEvent({
    action_type: actionType,
    entity_type: 'dispute',
    entity_id: disputeId,
    performed_by: actor,
    details: { ...details, actor_user_id: actorUserId },
  });

  if (hash) {
    await tenantDb(tenantId, 'dispute audit hash').update('disputes', { audit_hash: hash }).eq('id', disputeId);
  }
  return hash;
}

export async function openDispute(input: OpenDisputeInput): Promise<Dispute> {
  const { tenantId, subjectType, subjectId, raisedBy, traderStatement, actor, actorUserId } = input;
  const accountId = input.accountId ?? null;
  const id = randomUUID();

  const evidencePackId = await pinEvidencePack(tenantId, subjectType, subjectId, accountId);

  const { data, error } = await tenantDb(tenantId, 'dispute open')
    .insert('disputes', {
      id,
      subject_type: subjectType,
      subject_id: subjectId,
      account_id: accountId,
      raised_by: raisedBy,
      trader_statement: traderStatement,
      status: 'open',
      evidence_pack_id: evidencePackId,
    })
    .select('*')
    .single();

  if (error || !data) throw error ?? new Error('Failed to open dispute');

  await appendDisputeAudit(tenantId, id, 'dispute_opened', actor, actorUserId, {
    subject_type: subjectType,
    subject_id: subjectId,
    account_id: accountId,
    evidence_pack_id: evidencePackId,
  });

  const { data: withHash } = await tenantDb(tenantId, 'dispute open reread')
    .from('disputes')
    .eq('id', id)
    .maybeSingle();

  return rowToDispute((withHash ?? data) as DisputeRow);
}

export async function listDisputes(
  tenantId: string,
  filters: { status?: DisputeStatus; subjectType?: DisputeSubjectType } = {}
): Promise<Dispute[]> {
  let q = tenantDb(tenantId, 'dispute list').from('disputes').order('created_at', { ascending: false });
  if (filters.status) q = q.eq('status', filters.status);
  if (filters.subjectType) q = q.eq('subject_type', filters.subjectType);

  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as DisputeRow[]).map(rowToDispute);
}

export async function getDispute(tenantId: string, id: string): Promise<Dispute | null> {
  const { data, error } = await tenantDb(tenantId, 'dispute get').from('disputes').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? rowToDispute(data as DisputeRow) : null;
}

const VALID_TRANSITIONS: Record<DisputeStatus, DisputeStatus[]> = {
  open: ['under_review', 'upheld', 'overturned', 'withdrawn'],
  under_review: ['upheld', 'overturned', 'withdrawn'],
  upheld: [],
  overturned: [],
  withdrawn: [],
};

export class InvalidDisputeTransitionError extends Error {}

/**
 * Move a dispute forward: open/under_review -> under_review, or into a
 * terminal outcome (upheld/overturned/withdrawn) with a required written
 * resolution. Terminal states are final — a resolved dispute is the record.
 */
export async function transitionDispute(input: ResolveDisputeInput): Promise<Dispute> {
  const { tenantId, disputeId, status, resolution, actor, actorUserId } = input;

  const current = await getDispute(tenantId, disputeId);
  if (!current) throw new Error('Dispute not found');

  if (!VALID_TRANSITIONS[current.status].includes(status)) {
    throw new InvalidDisputeTransitionError(
      `Cannot move dispute from '${current.status}' to '${status}'`
    );
  }

  const isTerminal = TERMINAL_STATUSES.includes(status);
  if (isTerminal && !resolution) {
    throw new Error('resolution is required to resolve a dispute');
  }

  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (isTerminal) {
    patch.resolution = resolution;
    patch.resolved_by = actor;
    patch.resolved_at = new Date().toISOString();
  }

  const { data, error } = await tenantDb(tenantId, 'dispute transition')
    .update('disputes', patch)
    .eq('id', disputeId)
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('Failed to update dispute');

  await appendDisputeAudit(
    tenantId,
    disputeId,
    isTerminal ? `dispute_${status}` : 'dispute_under_review',
    actor,
    actorUserId,
    { from_status: current.status, to_status: status, resolution: resolution ?? undefined }
  );

  const { data: withHash } = await tenantDb(tenantId, 'dispute transition reread')
    .from('disputes')
    .eq('id', disputeId)
    .maybeSingle();

  return rowToDispute((withHash ?? data) as DisputeRow);
}

/**
 * Resolve the "rule" a dispute is about, for the overturn-rate rollup.
 * - breach: the violation's own violation_type.
 * - deduction: the violation_type of the violation that produced it.
 * - payout: payout decisions aren't tied to one rule, so they're bucketed
 *   separately rather than misattributed to a single violation_type.
 */
async function resolveRuleId(tenantId: string, dispute: Dispute): Promise<string> {
  if (dispute.subjectType === 'payout') return 'payout_decision';

  const violationId =
    dispute.subjectType === 'breach'
      ? dispute.subjectId
      : await (async () => {
          const { data } = await tenantDb(tenantId, 'overturn-rate deduction lookup')
            .from('deductions')
            .eq('id', dispute.subjectId)
            .maybeSingle();
          return (data?.violation_id as string | undefined) ?? null;
        })();

  if (!violationId) return 'unknown';

  const { data } = await tenantDb(tenantId, 'overturn-rate violation lookup')
    .from('violations')
    .eq('id', violationId)
    .maybeSingle();

  return (data?.violation_type as string | undefined) ?? 'unknown';
}

/**
 * The most useful number this feature produces (docs/HOW-IT-WORKS.md task
 * #4): per rule, how often the firm's own resolution of a dispute reverses
 * its original decision. Withdrawn cases are excluded — a trader dropping
 * a case says nothing about whether the rule was right.
 */
export async function computeOverturnRateByRule(tenantId: string): Promise<RuleOverturnRate[]> {
  const resolved = (await listDisputes(tenantId)).filter(
    (d) => d.status === 'upheld' || d.status === 'overturned'
  );

  const counts = new Map<string, { total: number; overturned: number }>();
  for (const dispute of resolved) {
    const ruleId = await resolveRuleId(tenantId, dispute);
    const entry = counts.get(ruleId) ?? { total: 0, overturned: 0 };
    entry.total += 1;
    if (dispute.status === 'overturned') entry.overturned += 1;
    counts.set(ruleId, entry);
  }

  return Array.from(counts.entries())
    .map(([ruleId, { total, overturned }]) => ({
      ruleId,
      ruleLabel: ruleId === 'payout_decision' ? 'Payout Decisions' : violationLabel(ruleId),
      totalResolved: total,
      overturned,
      overturnRate: total > 0 ? overturned / total : 0,
    }))
    .sort((a, b) => b.overturnRate - a.overturnRate || b.totalResolved - a.totalResolved);
}
