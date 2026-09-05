/**
 * The per-violation decision record.
 *
 * Shape follows the trader notice in docs/HOW-IT-WORKS.md §2 Flow 3 — the
 * rule / what happened / the arithmetic / the trades / the full record — so
 * the PDF a trader receives and the CSV a compliance reviewer opens are the
 * same document in two renderings, not two independent summaries that can
 * disagree.
 *
 * Everything here is plain data with no behaviour, because it is persisted
 * verbatim as `violation_reports.report_json` (00025) and read back months
 * later. The renderers (render-pdf.ts / render-csv.ts) are pure functions of
 * this object: nothing they emit is derived from a live query, so a report
 * downloaded after the equity snapshots behind it have been pruned is
 * byte-identical to the one downloaded the day it was generated.
 *
 * Optional fields are optional because the SOURCE ROW may not carry them, not
 * because they are cosmetic. An absent field must render as an explicit gap
 * ("—", or a line in `provenance.dataFidelity`), never as a fabricated value.
 */

/** Bump when a field changes meaning. Old rows keep their own version. */
export const VIOLATION_REPORT_SCHEMA_VERSION = 1;

/** Where a finding came from. `rule_pack` findings carry `rule.pack`. */
export type ReportRuleSource = 'rule_pack' | 'legacy_engine';

/** What the row this report describes actually is. */
export type ViolationReportSubjectType = 'violation' | 'breach_decision';

/**
 * Ordered kinds of thing that can appear on the timeline. Deliberately a
 * closed union: a timeline entry whose kind is not one of these is a fact the
 * report does not know how to explain, and inventing a label for it is how a
 * decision record starts asserting things nobody can defend.
 */
export type ReportTimelineKind =
  | 'trade'
  | 'equity_sample'
  | 'detected'
  | 'queued'
  | 'decided'
  | 'executed'
  | 'notice_sent'
  | 'dispute'
  | 'deduction';

export interface ViolationReport {
  schemaVersion: 1;
  reportId: string;
  generatedAt: string;
  generatedBy: string;

  header: {
    firmName: string;
    accountId: string;
    login: string;
    traderName?: string;
    phase?: string;
    assetClass?: string;
    planName?: string;
  };

  /** The rule AS WRITTEN when it fired — never re-resolved against today's pack. */
  rule: {
    id: string;
    label: string;
    limitAsWritten: string;
    source: ReportRuleSource;
    pack?: { id: string; name: string; version: number; contentHash: string };
    action?: string;
  };

  whatHappened: {
    observed: string;
    exceededBy?: number;
    sessionDay?: string;
    severity: string;
    detectedAt: string;
    status: string;
  };

  /**
   * The arithmetic, spelled out. Every line is a deterministic string built
   * from stored numbers — never from an LLM narrative, which is prose ABOUT
   * the decision and is carried separately in `provenance.generatedNarrative`.
   */
  arithmetic: Array<{ label: string; expression?: string; value: string }>;

  timeline: Array<{
    at: string;
    kind: ReportTimelineKind;
    summary: string;
    actor?: string;
  }>;

  trades: Array<{
    id: string;
    symbol: string;
    side: string;
    volume: number;
    openedAt: string;
    closedAt?: string;
    openPrice?: number;
    closePrice?: number;
    pnl?: number;
    flagged: boolean;
  }>;

  accountSnapshot: {
    balance: number;
    equity: number;
    startingBalance: number;
    startingDayBalance?: number;
    startingDayEquity?: number;
    drawdownFloor?: number;
    netTransfers?: number;
  };

  action: {
    queueStatus?: string;
    decision?: string;
    approver?: string;
    decidedAt?: string;
    executedAt?: string;
    deduction?: {
      amount: number;
      preBalance?: number;
      postBalance?: number;
      executedBy?: string;
    };
  };

  history: {
    priorViolations: Array<{
      id: string;
      ruleLabel: string;
      detectedAt: string;
      status: string;
    }>;
    disputes: Array<{
      id: string;
      status: string;
      openedAt: string;
      resolution?: string;
    }>;
  };

  provenance: {
    /**
     * What this report cannot honestly claim. A firm must be able to tell
     * "no intraday peak was observed" from "we did not sample often enough
     * to see one" — the second is a fidelity bound, not a finding.
     */
    dataFidelity: string[];
    auditHash?: string;
    evidencePackId?: string;
    /** LLM prose, quarantined and labelled. It never feeds `arithmetic`. */
    generatedNarrative?: {
      text: string;
      disclaimer: 'Generated prose describing the decision; not part of the decision.';
    };
    /** Which source rows were actually found. `false` means absent, not empty. */
    sourceRows: {
      violation: true;
      breachDecision: boolean;
      evidencePack: boolean;
      enforcementQueue: boolean;
    };
  };
}

/** The persisted `violation_reports` row (00025), as the app reads it. */
export interface ViolationReportRecord {
  id: string;
  tenantId: string;
  violationId: string;
  accountId: string;
  subjectType: ViolationReportSubjectType;
  report: ViolationReport;
  contentHash: string;
  generatedBy: string;
  generatedAt: string;
  auditHash: string | null;
}

/** The exact disclaimer attached to any generated prose carried in a report. */
export const NARRATIVE_DISCLAIMER =
  'Generated prose describing the decision; not part of the decision.' as const;
