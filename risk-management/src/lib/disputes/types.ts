/**
 * Dispute mode types (docs/HOW-IT-WORKS.md §6.4).
 *
 * A dispute is a firm-side case opened against one of its own decisions —
 * a breach, a payout decision, or a deduction — on a trader's behalf. It
 * carries the evidence pack that existed at the time the decision was made
 * (see lifecycle.ts `pinEvidencePack`) and every state change joins the
 * hash-chained audit trail (`logAuditEvent`), naming the real human behind
 * it, never a hardcoded actor string.
 */

export type DisputeSubjectType = 'breach' | 'payout' | 'deduction';

export type DisputeStatus = 'open' | 'under_review' | 'upheld' | 'overturned' | 'withdrawn';

/** Statuses a firm can resolve a dispute to — a written resolution is required for all three. */
export const TERMINAL_STATUSES: DisputeStatus[] = ['upheld', 'overturned', 'withdrawn'];

export interface Dispute {
  id: string;
  tenantId: string;
  subjectType: DisputeSubjectType;
  subjectId: string;
  accountId: string | null;
  raisedBy: string;
  raisedAt: string;
  traderStatement: string;
  status: DisputeStatus;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  evidencePackId: string | null;
  auditHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OpenDisputeInput {
  tenantId: string;
  subjectType: DisputeSubjectType;
  subjectId: string;
  accountId?: string | null;
  raisedBy: string;
  traderStatement: string;
  /** Human actor opening the case on the trader's behalf (guard-derived, never hardcoded). */
  actor: string;
  actorUserId: string;
}

export interface ResolveDisputeInput {
  tenantId: string;
  disputeId: string;
  status: DisputeStatus;
  /** Required when `status` is a terminal outcome (upheld/overturned/withdrawn). */
  resolution?: string;
  actor: string;
  actorUserId: string;
}

/** One row of the per-rule overturn-rate view (docs/HOW-IT-WORKS.md task #4). */
export interface RuleOverturnRate {
  ruleId: string;
  ruleLabel: string;
  totalResolved: number;
  overturned: number;
  overturnRate: number;
}
