/**
 * Evidence pack shared types.
 *
 * An evidence pack is the structured, human-readable dossier behind a payout
 * / violation / account / investigation decision — everything a reviewer (or
 * an auditor months later) needs to see why the platform did what it did.
 * Shapes here are deliberately aligned with what the existing analyzers
 * already emit so feature builders can map straight across:
 *
 * - `RuleFinding` mirrors `TradeViolation` from `src/types/payouts.ts` (as
 *   produced by `src/lib/payouts/detailed-risk-analysis.ts`): `ruleId`/
 *   `ruleLabel` <- `typeKey`/`type`, `evidence` <- the trade(s) that tripped
 *   the rule, `deductionAmount` <- `deductionAmount`.
 * - `networkLinks` mirrors the `network_evidence` shape built in
 *   `src/app/api/violations/[id]/route.ts` (account_a/account_b + matched
 *   trade pairs for grid/copy violations).
 *
 * Persisted as the `pack` JSONB column of the `evidence_packs` table
 * (see the evidence_packs / payout_decisions section of `supabase/migrations/00001_baseline_schema.sql`).
 */

export type EvidenceSubjectType = 'payout' | 'violation' | 'account' | 'investigation';

export type RuleVerdict = 'breach' | 'pass' | 'warning';

/** One trade cited as evidence for a rule finding. */
export interface TradeEvidenceRow {
  tradeId: string;
  symbol: string;
  openTime: string;
  closeTime: string;
  lots: number;
  profit: number;
  note?: string;
}

/** One rule evaluated against a subject (account/payout), breach or not. */
export interface RuleFinding {
  ruleId: string;
  ruleLabel: string;
  threshold: string | number;
  observed: string | number;
  verdict: RuleVerdict;
  evidence: TradeEvidenceRow[];
  deductionAmount: number;
  /**
   * The arithmetic behind `observed`, verbatim from the rule-pack evaluator's
   * `BreachEvidence.math` (src/lib/rulepack/types.ts). Only set for rule-pack
   * breaches — legacy findings have no equivalent. NOTE: the evidence page
   * (src/app/(dashboard)/evidence/[id]/page.tsx) does not render this field
   * yet; surfacing it there is a follow-up UI change, out of scope here.
   */
  math?: string;
}

/** A network/ring linkage surfaced in the evidence pack (see src/lib/network/types.ts). */
export interface EvidenceNetworkLink {
  accountId: string;
  kind: string;
  detail: string;
  weight: number;
}

/** One prior audit_log-style entry rendered into the pack. */
export interface EvidenceAuditEntry {
  actionType: string;
  performedBy: string;
  occurredAt: string;
  detail: string;
}

/** One prior decision made on the same subject (payout_decisions row, human-readable). */
export interface EvidenceDecisionHistoryEntry {
  decisionId: string;
  decision: 'preapprove' | 'approve' | 'reject' | 'hold';
  actor: string;
  decidedAt: string;
  summary: string;
}

export interface EvidenceDeductionMathLine {
  label: string;
  amount: number;
  note?: string;
}

/** The full structured dossier: `pack` column contents. */
export interface EvidencePackSections {
  accountSummary: Record<string, unknown>;
  scoringTrail: RuleFinding[];
  deductionMath: EvidenceDeductionMathLine[];
  newsEvents: Array<{ title: string; country: string; date: string; impact: string; source?: string }>;
  networkLinks: EvidenceNetworkLink[];
  auditEntries: EvidenceAuditEntry[];
  decisionHistory: EvidenceDecisionHistoryEntry[];
  /** Provenance of the rule pack that produced this pack's findings, when any
   *  did (src/lib/violations/record.ts `details_json.rule_pack_*`). Absent
   *  for demo packs and for packs built entirely from legacy findings. */
  rulePack?: { id: string; version: number; contentHash: string };
}

/** The full evidence pack — mirrors the `evidence_packs` table row. */
export interface EvidencePack {
  id: string;
  subjectType: EvidenceSubjectType;
  subjectId: string;
  accountId: string | null;
  assetClass: string | null;
  title: string;
  createdAt: string;
  createdBy: string | null;
  narrative: string | null;
  sections: EvidencePackSections;
}
