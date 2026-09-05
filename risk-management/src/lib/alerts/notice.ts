import type { EvidencePack } from '@/lib/evidence/types';
import { formatCurrency } from '@/lib/utils/format';

/**
 * Drafts the trader-facing breach notice from an already-assembled evidence
 * pack (src/lib/evidence/builder.ts) — this module does no independent
 * analysis, it only formats the pack's own narrative + rule findings + math
 * into a subject/body the risk desk can review and send. Nothing here sends
 * anything: the caller queues the draft into `enforcement_queue` for a human
 * to approve (see src/app/api/cron/detect-violations), matching the
 * automation-not-autonomy rule — the system may prepare an action, it may
 * never take one.
 */

export interface TraderNoticeDraft {
  subject: string;
  body: string;
  citedRules: string[];
  totalDeduction: number;
}

export interface TraderNoticeOptions {
  /**
   * Absolute URL of the trader-facing decision record
   * (`/api/trader/<token>/violations/<id>/report`). When supplied, the notice
   * closes with the "Full decision record: [link]" line from
   * docs/HOW-IT-WORKS.md §2 Flow 3 — the difference between a trader who
   * argues with the market and one who opens a chargeback.
   *
   * Optional because the caller may not have minted a trader link yet; a
   * notice with no link is a worse notice, not an invalid one.
   */
  reportUrl?: string;
}

export function draftTraderNotice(
  pack: EvidencePack,
  opts?: TraderNoticeOptions
): TraderNoticeDraft {
  const citedRules = pack.sections.scoringTrail.map((r) => r.ruleLabel);
  const totalDeduction = pack.sections.scoringTrail.reduce((sum, r) => sum + (r.deductionAmount || 0), 0);

  const subject = `Account Review — ${citedRules.join(', ') || 'Violation'} (Account ${pack.accountId ?? pack.subjectId})`;

  const ruleLines = pack.sections.scoringTrail
    .map((r) => `- ${r.ruleLabel}: ${r.observed} (threshold: ${r.threshold}) — ${formatCurrency(r.deductionAmount)} deduction`)
    .join('\n');

  const body = [
    `This is a DRAFT notice pending risk-team review — it has not been sent.`,
    '',
    pack.narrative ?? 'No narrative summary available.',
    '',
    ruleLines ? `Findings:\n${ruleLines}` : 'No individual rule findings recorded.',
    '',
    `Total deduction: ${formatCurrency(totalDeduction)}`,
    ...(opts?.reportUrl ? ['', `Full decision record: ${opts.reportUrl}`] : []),
  ].join('\n');

  return { subject, body, citedRules, totalDeduction };
}
