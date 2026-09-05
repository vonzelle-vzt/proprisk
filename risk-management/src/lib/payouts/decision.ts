import { violationLabel } from '@/lib/violations/labels';
import { formatCurrency } from '@/lib/utils/format';
import { DEMO_MODE } from '@/lib/demo';
import { askClaude, CLAUDE_MODELS } from '@/lib/ai/claude';
import type { PayoutRecord } from '@/types/payouts';

/**
 * Explainable payout decisions — composes a deterministic, trader-defensible
 * rationale for a preapprove/approve/reject/hold action. This module is safe
 * to import from both server routes and client components: the compose path
 * below does no I/O and never touches Claude directly. `polishExplanation` is
 * the only piece that talks to Claude, and it's guarded + try/catch so it can
 * be called unconditionally by server callers.
 */

export type PayoutDecisionAction = 'preapprove' | 'approve' | 'reject' | 'hold';

export interface DecisionCitedRule {
  ruleId: string;
  label: string;
  observed: string;
  threshold?: string;
  tradeCount: number;
  deduction: number;
}

export interface DecisionMathPerRule {
  ruleId: string;
  label: string;
  deduction: number;
}

export interface DecisionMath {
  requestedAmount: number;
  totalDeductions: number;
  adjustedAmount: number;
  perRule: DecisionMathPerRule[];
}

export interface DecisionRationale {
  citedRules: DecisionCitedRule[];
  math: DecisionMath;
  riskFactors: string[];
  decisionBasis: string[];
}

export interface ComposedDecision {
  rationale: DecisionRationale;
  explanation: string;
}

/**
 * Minimal shape of the trade-level analysis this module can use for richer
 * "observed" text (trade counts, per-trade explanations). Structurally
 * compatible with `PayoutAnalysisResult` in
 * `src/components/payouts/expanded-payout.tsx` and the `data` field returned
 * by `POST /api/payouts/[id]/analyze` — declared locally rather than imported
 * from the component so `lib/` never depends on `components/`.
 *
 * Optional: when omitted (e.g. the preapprove route only has the enriched
 * `PayoutRecord`, not a fresh analyze() call), citedRules/math fall back to
 * `record.platformDeductions`, which already carries the same totals.
 */
export interface DecisionAnalysisInput {
  violation_details?: Record<string, { trade_id: string; explanation: string; amount: number }[]>;
  deduction_breakdown?: Record<string, number>;
  total_deductions?: number;
  violation_count?: number;
}

export interface ComposeDecisionRationaleInput {
  record: PayoutRecord;
  analysis?: DecisionAnalysisInput | null;
  decision: PayoutDecisionAction;
}

function requestedAmountOf(record: PayoutRecord): number {
  if (
    record.profitSharePercentage &&
    record.profitSharePercentage > 0 &&
    record.profitSharePercentage < 100 &&
    (record.clientAmount ?? 0) > 0
  ) {
    return record.clientAmount! / (record.profitSharePercentage / 100);
  }
  return record.amount ?? record.clientAmount ?? 0;
}

function buildRiskFactors(record: PayoutRecord): string[] {
  const factors: string[] = [];
  if (record.isBlackListed) factors.push('Account is blacklisted');
  if (record.kycVerified === false) {
    factors.push(`KYC not verified${record.kycStatusDetail ? ` (${record.kycStatusDetail})` : ''}`);
  }
  if (record.ipMismatch) factors.push('IP mismatch detected against KYC country');
  if (record.kycRiskLabels && record.kycRiskLabels.length > 0) {
    factors.push(`KYC risk labels: ${record.kycRiskLabels.join(', ')}`);
  }
  if (
    record.consistencyAtRequest != null &&
    record.consistencyRequired != null &&
    record.consistencyAtRequest > record.consistencyRequired
  ) {
    factors.push(
      `Consistency ${record.consistencyAtRequest.toFixed(1)}% exceeds required ${record.consistencyRequired}%`
    );
  }
  if (record.banNewsTrading) factors.push('Account restricted from news trading');
  if (record.banHFT) factors.push('Account restricted from HFT');
  if (record.banMTGL) factors.push('Account restricted from martingale trading');
  return factors;
}

function buildCitedRules(
  record: PayoutRecord,
  analysis?: DecisionAnalysisInput | null
): DecisionCitedRule[] {
  const breakdown = analysis?.deduction_breakdown ?? record.platformDeductions?.breakdownByType ?? {};
  return Object.entries(breakdown)
    .filter(([, amount]) => (amount || 0) > 0)
    .map(([ruleId, amount]) => {
      const details = analysis?.violation_details?.[ruleId] || [];
      return {
        ruleId,
        label: violationLabel(ruleId),
        observed:
          details.length > 0
            ? `${details.length} flagged trade${details.length !== 1 ? 's' : ''}`
            : 'Flagged by platform-side deduction calculation',
        tradeCount: details.length,
        deduction: amount,
      };
    })
    .sort((a, b) => b.deduction - a.deduction);
}

function buildDecisionBasis(
  decision: PayoutDecisionAction,
  citedRules: DecisionCitedRule[],
  riskFactors: string[]
): string[] {
  const basis: string[] = [];
  if (citedRules.length > 0) {
    basis.push(
      `${citedRules.length} confirmed rule violation${citedRules.length !== 1 ? 's' : ''}: ${citedRules
        .map((r) => r.label)
        .join(', ')}`
    );
  } else {
    basis.push("No confirmed rule violations against this account's trade tape");
  }
  if (riskFactors.length > 0) basis.push(...riskFactors);
  if (decision === 'reject' && citedRules.length === 0) {
    basis.push('Rejection is not supported by violation evidence alone — review risk factors above');
  }
  return basis;
}

function buildExplanation(
  record: PayoutRecord,
  decision: PayoutDecisionAction,
  rationale: DecisionRationale
): string {
  const { citedRules, math, riskFactors } = rationale;
  const who =
    record.firstName && record.lastName ? `${record.firstName} ${record.lastName}` : `account ${record.accountId}`;
  const ruleList = citedRules.map((r) => `${r.label} (-${formatCurrency(r.deduction)})`).join(', ');

  const decisionLine = (() => {
    switch (decision) {
      case 'approve':
        return citedRules.length > 0
          ? `Approved for ${formatCurrency(math.adjustedAmount)} after deducting ${ruleList} from a ${formatCurrency(
              math.requestedAmount
            )} request.`
          : `Approved for ${formatCurrency(math.adjustedAmount)}. No confirmed rule violations against the ${formatCurrency(
              math.requestedAmount
            )} request.`;
      case 'reject':
        return citedRules.length > 0
          ? `Rejected. ${ruleList} account for ${formatCurrency(math.totalDeductions)} against a ${formatCurrency(
              math.requestedAmount
            )} request — the trading pattern itself is the violation, not incidental to otherwise-legitimate gains.`
          : `Rejected on risk factors: ${riskFactors.join('; ') || 'see review notes'}.`;
      case 'hold':
        return `Held pending review. ${ruleList || 'No confirmed violations yet'} — manual confirmation required before releasing ${formatCurrency(
          math.adjustedAmount
        )}.`;
      default:
        return `Pre-approved pending final risk check. Provisional deductions: ${ruleList || 'none'}.`;
    }
  })();

  const riskLine =
    riskFactors.length > 0 && decision !== 'reject' ? ` Risk factors noted: ${riskFactors.join('; ')}.` : '';

  return `Payout decision for ${who} (account ${record.accountId}): ${decisionLine}${riskLine}`;
}

/** Deterministic core — pure function, no I/O, safe for client or server. */
export function composeDecisionRationale(input: ComposeDecisionRationaleInput): ComposedDecision {
  const { record, analysis, decision } = input;
  const requestedAmount = requestedAmountOf(record);
  const citedRules = buildCitedRules(record, analysis);
  const totalDeductions =
    analysis?.total_deductions ?? record.platformDeductions?.totalDeductions ?? citedRules.reduce((s, r) => s + r.deduction, 0);
  const adjustedAmount = Math.max(0, requestedAmount - totalDeductions);
  const riskFactors = buildRiskFactors(record);
  const decisionBasis = buildDecisionBasis(decision, citedRules, riskFactors);

  const math: DecisionMath = {
    requestedAmount,
    totalDeductions,
    adjustedAmount,
    perRule: citedRules.map((r) => ({ ruleId: r.ruleId, label: r.label, deduction: r.deduction })),
  };

  const rationale: DecisionRationale = { citedRules, math, riskFactors, decisionBasis };
  const explanation = buildExplanation(record, decision, rationale);

  return { rationale, explanation };
}

/**
 * Optional Claude polish of the explanation text in live mode only. Rewrites
 * prose for clarity — never touches the numbers or rationale structure.
 * Guarded + try/catch by design: server callers can invoke this
 * unconditionally and always get a usable explanation back.
 */
export async function polishExplanation(composed: ComposedDecision): Promise<string> {
  if (DEMO_MODE || !process.env.ANTHROPIC_API_KEY) return composed.explanation;
  try {
    const polished = await askClaude({
      model: CLAUDE_MODELS.narrative,
      system:
        'You rewrite payout-decision explanations for clarity and professionalism. Preserve every number, rule name, and fact exactly as given — do not invent, omit, or recompute anything. Return only the rewritten paragraph, no preamble or commentary.',
      prompt: `Rewrite this payout decision explanation for a trader-facing record. Keep all figures and rule names identical, just improve the prose:\n\n${composed.explanation}`,
      maxTokens: 400,
    });
    return polished.trim() || composed.explanation;
  } catch {
    return composed.explanation;
  }
}
