import { brand } from '@/config/brand';
import { ViolationType } from '@/types/database';

interface TemplateVars {
  trader_name: string;
  account_login: string;
  violation_type_label: string;
  deduction_amount: string;
  date: string;
}

export interface EmailTemplate {
  subject: string;
  body: string;
}

const BASE_STYLE = `
  font-family: 'Inter', Arial, sans-serif;
  background-color: #0a0a0a;
  color: #f5f5f5;
  padding: 32px;
`;

const CARD_STYLE = `
  background-color: #1a1a1a;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 16px;
  padding: 24px;
  margin: 16px 0;
`;

function wrapInLayout(content: string): string {
  return `
    <div style="${BASE_STYLE}">
      <div style="max-width: 600px; margin: 0 auto;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: ${brand.colors.accent || '#dc2626'}; font-size: 20px; margin: 0;">${brand.productName}</h1>
          <p style="color: #9ca3af; font-size: 12px; margin-top: 4px;">${brand.companyName}</p>
        </div>
        <div style="${CARD_STYLE}">
          ${content}
        </div>
        <p style="color: #6b7280; font-size: 11px; text-align: center; margin-top: 24px;">
          This is an automated message from the ${brand.productName} Platform. Do not reply to this email.
        </p>
      </div>
    </div>
  `;
}

const templates: Record<string, (vars: TemplateVars) => EmailTemplate> = {
  overleveraging: (vars) => ({
    subject: `[Risk Management] Over-Exposure Violation - Account ${vars.account_login}`,
    body: wrapInLayout(`
      <h2 style="color: #f5f5f5; margin-top: 0;">Over-Exposure Policy Violation</h2>
      <p style="color: #d1d5db;">Dear ${vars.trader_name},</p>
      <p style="color: #d1d5db;">Your trading account <strong style="color: #dc2626;">${vars.account_login}</strong> has exceeded the maximum allowed lot size on <strong>${vars.date}</strong>.</p>
      <div style="background: rgba(220,38,38,0.1); border-left: 3px solid #dc2626; padding: 12px 16px; border-radius: 8px; margin: 16px 0;">
        <p style="color: #fca5a5; margin: 0;">Deduction Amount: <strong>$${vars.deduction_amount}</strong></p>
      </div>
      <p style="color: #d1d5db;">Profits attributable to the excess exposure have been deducted. Please review the over-exposure policy for your account size.</p>
    `),
  }),
  hft: (vars) => ({
    subject: `[Risk Management] HFT Violation - Account ${vars.account_login}`,
    body: wrapInLayout(`
      <h2 style="color: #f5f5f5; margin-top: 0;">High-Frequency Trading Violation</h2>
      <p style="color: #d1d5db;">Dear ${vars.trader_name},</p>
      <p style="color: #d1d5db;">High-frequency trading activity was detected on account <strong style="color: #dc2626;">${vars.account_login}</strong> on <strong>${vars.date}</strong>.</p>
      <div style="background: rgba(220,38,38,0.1); border-left: 3px solid #dc2626; padding: 12px 16px; border-radius: 8px; margin: 16px 0;">
        <p style="color: #fca5a5; margin: 0;">Deduction Amount: <strong>$${vars.deduction_amount}</strong></p>
      </div>
      <p style="color: #d1d5db;">Your trading pattern exceeded the allowed trade frequency thresholds. Please review the HFT policy.</p>
    `),
  }),
  martingale: (vars) => ({
    subject: `[Risk Management] Martingale Violation - Account ${vars.account_login}`,
    body: wrapInLayout(`
      <h2 style="color: #f5f5f5; margin-top: 0;">Martingale Strategy Violation</h2>
      <p style="color: #d1d5db;">Dear ${vars.trader_name},</p>
      <p style="color: #d1d5db;">A martingale trading pattern was detected on account <strong style="color: #dc2626;">${vars.account_login}</strong> on <strong>${vars.date}</strong>.</p>
      <div style="background: rgba(220,38,38,0.1); border-left: 3px solid #dc2626; padding: 12px 16px; border-radius: 8px; margin: 16px 0;">
        <p style="color: #fca5a5; margin: 0;">Deduction Amount: <strong>$${vars.deduction_amount}</strong></p>
      </div>
      <p style="color: #d1d5db;">Increasing position sizes after losses to recover is a prohibited strategy. Profits from the recovery trade have been deducted.</p>
    `),
  }),
  news: (vars) => ({
    subject: `[Risk Management] News Trading Violation - Account ${vars.account_login}`,
    body: wrapInLayout(`
      <h2 style="color: #f5f5f5; margin-top: 0;">News Trading Violation</h2>
      <p style="color: #d1d5db;">Dear ${vars.trader_name},</p>
      <p style="color: #d1d5db;">Trading activity within the restricted news window was detected on account <strong style="color: #dc2626;">${vars.account_login}</strong> on <strong>${vars.date}</strong>.</p>
      <div style="background: rgba(220,38,38,0.1); border-left: 3px solid #dc2626; padding: 12px 16px; border-radius: 8px; margin: 16px 0;">
        <p style="color: #fca5a5; margin: 0;">Deduction Amount: <strong>$${vars.deduction_amount}</strong></p>
      </div>
      <p style="color: #d1d5db;">Trading within 5 minutes of a high-impact news event is prohibited. Profits from the affected trade have been deducted.</p>
    `),
  }),
  grid: (vars) => ({
    subject: `[Risk Management] Grid Trading Violation - Account ${vars.account_login}`,
    body: wrapInLayout(`
      <h2 style="color: #f5f5f5; margin-top: 0;">Grid Trading Violation</h2>
      <p style="color: #d1d5db;">Dear ${vars.trader_name},</p>
      <p style="color: #d1d5db;">Coordinated reverse trading was detected involving account <strong style="color: #dc2626;">${vars.account_login}</strong> on <strong>${vars.date}</strong>.</p>
      <div style="background: rgba(220,38,38,0.1); border-left: 3px solid #dc2626; padding: 12px 16px; border-radius: 8px; margin: 16px 0;">
        <p style="color: #fca5a5; margin: 0;">Deduction Amount: <strong>$${vars.deduction_amount}</strong></p>
      </div>
      <p style="color: #d1d5db;">Grid trading between accounts is a prohibited strategy. This case has been flagged for review.</p>
    `),
  }),
  copy: (vars) => ({
    subject: `[Risk Management] Copy Trading Violation - Account ${vars.account_login}`,
    body: wrapInLayout(`
      <h2 style="color: #f5f5f5; margin-top: 0;">Copy Trading Violation</h2>
      <p style="color: #d1d5db;">Dear ${vars.trader_name},</p>
      <p style="color: #d1d5db;">Unauthorized copy trading activity was detected involving account <strong style="color: #dc2626;">${vars.account_login}</strong> on <strong>${vars.date}</strong>.</p>
      <div style="background: rgba(220,38,38,0.1); border-left: 3px solid #dc2626; padding: 12px 16px; border-radius: 8px; margin: 16px 0;">
        <p style="color: #fca5a5; margin: 0;">Deduction Amount: <strong>$${vars.deduction_amount}</strong></p>
      </div>
      <p style="color: #d1d5db;">Copy trading across different user profiles is prohibited. This case has been flagged for review.</p>
    `),
  }),
};

export interface ChallengeResetEmailVars {
  firstName: string;
  violatedAccounts: { login: string; phaseLabel: string }[];
  planName: string;
  phaseLabel: string;
  violations: { label: string; deductionAmount: number }[];
  retryAccountId: string;
}

export function buildChallengeResetEmail(vars: ChallengeResetEmailVars): EmailTemplate {
  const violationList = vars.violations
    .map((v) => `<li style="color:#fca5a5; margin:4px 0;">${v.label} — <strong>$${v.deductionAmount.toFixed(2)}</strong></li>`)
    .join('');

  const isSingle = vars.violatedAccounts.length === 1;
  const accountNoun = isSingle ? 'account' : 'accounts';
  const loginList = vars.violatedAccounts.map((a) => a.login).join(', ');
  const accountDesc = vars.violatedAccounts
    .map((a) => `<strong style="color:#dc2626;">${a.login}</strong>${a.phaseLabel ? ` (${a.phaseLabel})` : ''}`)
    .join(' and ');

  return {
    subject: `[Risk Management] Challenge Violation Detected – Account${isSingle ? '' : 's'} ${loginList}`,
    body: wrapInLayout(`
      <h2 style="color:#f5f5f5; margin-top:0;">Challenge Violation Notice</h2>
      <p style="color:#d1d5db;">Dear ${vars.firstName},</p>
      <p style="color:#d1d5db;">
        A review of your challenge ${accountNoun} ${accountDesc}
        (${vars.planName}) has identified the following rule violation(s):
      </p>
      <div style="background:rgba(220,38,38,0.1); border-left:3px solid #dc2626; padding:12px 16px; border-radius:8px; margin:16px 0;">
        <ul style="margin:0; padding-left:16px;">${violationList}</ul>
      </div>
      <p style="color:#d1d5db;">
        As a result, you will need to <strong>re-complete your challenge</strong> to qualify for a funded account.
      </p>
      <p style="color:#d1d5db;">
        A new <strong>${vars.phaseLabel}</strong> account has been issued to you:
        <strong style="color:#60a5fa;">${vars.retryAccountId}</strong>.
        Please use this account to meet the challenge profit target and have your funded account enabled.
      </p>
      <p style="color:#d1d5db;">If you have any questions, please contact support.</p>
    `),
  };
}

export interface PayoutViolationEmailVars {
  firstName: string;
  login: string;
  planName: string;
  violations: { label: string; deductionAmount: number }[];
  totalDeductions: number;
  payoutAmount: number;
  /** Explainable-decision rationale (see `src/lib/payouts/decision.ts`) — optional
   *  for backward compatibility with call sites that don't have a composed
   *  decision (e.g. the legacy manual violation-email flow). When present,
   *  renders a "Decision rationale" block citing the specific rules and math
   *  behind the deduction, matching this template's existing styling. */
  rationale?: {
    citedRules: { ruleId: string; label: string; observed: string; deduction: number }[];
    math: { requestedAmount: number; totalDeductions: number; adjustedAmount: number };
  };
}

export function buildPayoutViolationEmail(vars: PayoutViolationEmailVars): EmailTemplate {
  const violationList = vars.violations
    .map((v) => `<li style="color:#fca5a5; margin:4px 0;">${v.label} — <strong>$${v.deductionAmount.toFixed(2)}</strong></li>`)
    .join('');

  const rejected = vars.totalDeductions >= vars.payoutAmount;

  const rationaleBlock = vars.rationale
    ? `
      <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.1); border-radius:8px; padding:16px; margin:16px 0;">
        <h3 style="color:#f5f5f5; margin:0 0 8px; font-size:14px;">Decision Rationale</h3>
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead>
            <tr>
              <th style="text-align:left; color:#9ca3af; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.1);">Rule</th>
              <th style="text-align:left; color:#9ca3af; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.1);">Observed</th>
              <th style="text-align:right; color:#9ca3af; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.1);">Deduction</th>
            </tr>
          </thead>
          <tbody>
            ${vars.rationale.citedRules
              .map(
                (r) => `<tr>
                  <td style="color:#d1d5db; padding:4px 0;">${r.label}</td>
                  <td style="color:#9ca3af; padding:4px 0;">${r.observed}</td>
                  <td style="color:#fca5a5; text-align:right; padding:4px 0;">-$${r.deduction.toFixed(2)}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
        <div style="margin-top:12px; padding-top:12px; border-top:1px solid rgba(255,255,255,0.1); font-size:13px;">
          <p style="color:#9ca3af; margin:2px 0;">Requested: <strong style="color:#d1d5db;">$${vars.rationale.math.requestedAmount.toFixed(2)}</strong></p>
          <p style="color:#9ca3af; margin:2px 0;">Total Deductions: <strong style="color:#fca5a5;">-$${vars.rationale.math.totalDeductions.toFixed(2)}</strong></p>
          <p style="color:#9ca3af; margin:2px 0;">Adjusted Payout: <strong style="color:#60a5fa;">$${vars.rationale.math.adjustedAmount.toFixed(2)}</strong></p>
        </div>
      </div>`
    : '';

  return {
    subject: `[Risk Management] Payout Violation – Account ${vars.login}`,
    body: wrapInLayout(`
      <h2 style="color:#f5f5f5; margin-top:0;">Payout Violation Notice</h2>
      <p style="color:#d1d5db;">Dear ${vars.firstName},</p>
      <p style="color:#d1d5db;">
        A review of your funded account <strong style="color:#dc2626;">${vars.login}</strong>
        ${vars.planName ? `(${vars.planName})` : ''} has identified the following rule violation(s)
        affecting your payout request:
      </p>
      <div style="background:rgba(220,38,38,0.1); border-left:3px solid #dc2626; padding:12px 16px; border-radius:8px; margin:16px 0;">
        <ul style="margin:0; padding-left:16px;">${violationList}</ul>
        <p style="color:#fca5a5; margin:12px 0 0; font-weight:600;">
          Total Deductions: $${vars.totalDeductions.toFixed(2)}
        </p>
      </div>
      ${rationaleBlock}
      ${rejected
        ? `<p style="color:#d1d5db;">
            Because the total deductions <strong style="color:#dc2626;">($${vars.totalDeductions.toFixed(2)})</strong>
            exceed your payout amount of <strong>$${vars.payoutAmount.toFixed(2)}</strong>,
            your payout request has been <strong style="color:#dc2626;">rejected</strong>.
          </p>`
        : `<p style="color:#d1d5db;">
            These deductions will be subtracted from your payout amount of
            <strong>$${vars.payoutAmount.toFixed(2)}</strong>, resulting in an adjusted payout of
            <strong style="color:#60a5fa;">$${(vars.payoutAmount - vars.totalDeductions).toFixed(2)}</strong>.
          </p>`
      }
      <p style="color:#d1d5db;">If you have any questions, please contact support.</p>
    `),
  };
}

export function getEmailTemplate(violationType: ViolationType, vars: TemplateVars): EmailTemplate {
  const templateFn = templates[violationType];
  if (!templateFn) {
    return {
      subject: `[Risk Management] ${vars.violation_type_label} Violation - Account ${vars.account_login}`,
      body: wrapInLayout(`
        <h2 style="color: #f5f5f5; margin-top: 0;">${vars.violation_type_label} Violation</h2>
        <p style="color: #d1d5db;">Dear ${vars.trader_name},</p>
        <p style="color: #d1d5db;">A violation was detected on account <strong style="color: #dc2626;">${vars.account_login}</strong> on <strong>${vars.date}</strong>.</p>
        <div style="background: rgba(220,38,38,0.1); border-left: 3px solid #dc2626; padding: 12px 16px; border-radius: 8px; margin: 16px 0;">
          <p style="color: #fca5a5; margin: 0;">Deduction Amount: <strong>$${vars.deduction_amount}</strong></p>
        </div>
      `),
    };
  }
  return templateFn(vars);
}
