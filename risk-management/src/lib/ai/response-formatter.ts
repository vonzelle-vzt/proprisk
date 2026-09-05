import type { MorningReportData, RiskScoreResult, AnomalyFlag } from '@/types/ai';
import type { PlatformAccount, PlatformUser, PlatformTradeStats } from '@/types/platform';
import type { PlatformDeductions } from '@/types/payouts';
import type { EnrichedPayout } from '@/lib/payouts/enrich';
import type { FraudHunterScanResult, FraudInvestigation } from '@/types/fraud';
import type {
  EnforcementRecommendation,
  EnforcementQueueSummary,
  AccountViolationHistory,
} from '@/types/enforcement';
import { getViolationLabel, analyzeTradeProfile } from './analytics';

function $(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

// ─── Help ────────────────────────────────────────────────────

export function formatHelpResponse(): string {
  return `## Risk Analytics Bot

Here's what I can help you with:

### Reports
- **"general report"** — Full risk overview with live data
- **"pending payouts"** — Current pending payout queue
- **"violations summary"** — Violation breakdown across all accounts
- **"deduction history"** — Recent deduction ledger events

### Account Analysis
- **"account 12345"** — Full account lookup with risk score
- **"risk score for 12345"** — Detailed risk scoring
- **"violations for 12345"** — Account-specific violations
- **"trades for 12345"** — Trade history and performance stats

### Security
- **"high risk accounts"** — Flagged high-risk accounts
- **"security check"** — Blacklist, KYC, and anomaly review

### Fraud & Enforcement
- **"fraud scan"** — Run fraud detection across accounts
- **"fraud report"** — View open fraud investigations
- **"enforcement queue"** — Pending enforcement actions
- **"enforcement summary"** — Enforcement queue overview
- **"repeat offenders"** — Accounts with repeat violations

You can also type an **account ID number** directly or ask general questions about the data.`;
}

// ─── Unknown ─────────────────────────────────────────────────

export function formatUnknownResponse(message: string): string {
  return `I wasn't able to process that request. Here are some things you can ask:

- **"general report"** — Full risk overview with live data
- **"pending payouts"** — View current pending payouts
- **"high risk accounts"** — See flagged accounts
- **"account 12345"** — Look up a specific account
- **"violations summary"** — Violation breakdown across accounts
- **"security check"** — Blacklist and KYC flag review
- **"help"** — See all available commands

You can also ask general questions about the data, like *"how many payouts are pending?"* or *"which accounts have the highest deductions?"*

You typed: *"${message}"*`;
}

// ─── Pending Payouts ─────────────────────────────────────────

export function formatPendingPayoutsResponse(payouts: EnrichedPayout[]): string {
  if (payouts.length === 0) {
    return '## Pending Payouts\n\nNo pending payouts found at this time.';
  }

  const totalAmount = payouts.reduce((s, p) => s + (p.amount || p.clientAmount || 0), 0);
  const withViolations = payouts.filter((p) => p.platformViolations && p.platformViolations.length > 0);
  const blacklisted = payouts.filter((p) => p.isBlackListed);

  let md = `## Pending Payouts\n\n`;

  // Summary block
  md += `### At a Glance\n\n`;
  md += `- **Total Pending:** ${payouts.length} payouts\n`;
  md += `- **Total Amount:** ${$(totalAmount)}\n`;
  md += `- **With Violations:** ${withViolations.length} accounts\n`;
  if (blacklisted.length > 0) {
    md += `- **Blacklisted:** ${blacklisted.length} account(s)\n`;
  }

  // Alerts
  if (blacklisted.length > 0) {
    md += `\n> **ALERT:** ${blacklisted.length} payout(s) from blacklisted users require immediate review\n`;
  }

  // Top payouts list
  md += `\n### Payout Queue\n\n`;

  const display = payouts.slice(0, 20);
  for (let i = 0; i < display.length; i++) {
    const p = display[i];
    const name = [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Unknown';
    const amount = p.amount || p.clientAmount || 0;
    const violations = p.platformViolations?.length
      ? p.platformViolations.map(getViolationLabel).join(', ')
      : 'None';
    const flags: string[] = [];
    if (p.isBlackListed) flags.push('BLACKLISTED');
    if (p.kycStatus !== 'Verified') flags.push('KYC Issue');

    md += `**${i + 1}. Account ${p.accountId}** — ${name}\n`;
    md += `- Plan: ${p.plan || '—'} | Amount: **${$(amount)}**\n`;
    md += `- Violations: ${violations}\n`;
    if (flags.length > 0) {
      md += `- Flags: ${flags.join(', ')}\n`;
    }
    md += `\n`;
  }

  if (payouts.length > 20) {
    md += `*...and ${payouts.length - 20} more payouts*\n`;
  }

  return md;
}

// ─── Account Lookup ──────────────────────────────────────────

export function formatAccountLookupResponse(
  accountId: string,
  account: PlatformAccount | null,
  user: PlatformUser | null,
  deductions: PlatformDeductions | null,
  riskScore: RiskScoreResult,
  anomalies: AnomalyFlag[]
): string {
  if (!account) {
    return `## Account Lookup\n\nAccount **${accountId}** not found. Please verify the account ID.`;
  }

  let md = `## Account ${accountId}\n\n`;

  // Risk badge
  const badge =
    riskScore.level === 'critical' ? 'CRITICAL'
    : riskScore.level === 'high' ? 'HIGH'
    : riskScore.level === 'medium' ? 'MEDIUM'
    : 'LOW';
  md += `**Risk Score: ${riskScore.score}/100 (${badge})**\n\n`;

  // Anomaly alerts
  if (anomalies.length > 0) {
    for (const a of anomalies) {
      md += `> **${a.severity === 'critical' ? 'CRITICAL' : 'WARNING'}**: ${a.description}\n\n`;
    }
  }

  // Account info
  md += `### Account Details\n\n`;
  md += `- **Login:** ${account.login}\n`;
  md += `- **Plan:** ${account.planName}\n`;
  md += `- **Starting Balance:** ${$(account.startingBalance || 0)}\n`;
  md += `- **Last Balance:** ${$(account.lastBalance || 0)}\n`;
  md += `- **Last Equity:** ${$(account.lastEquity || 0)}\n`;
  md += `- **Traded Days:** ${account.tradedDays ?? '—'}\n`;
  md += `- **Approved Payouts:** ${account.numApprovedPayouts ?? 0}\n`;
  md += `- **Phase:** ${account.phase ?? '—'}\n`;

  const bans: string[] = [];
  if (account.banNewsTrading === 1) bans.push('News');
  if (account.banHFT === 1) bans.push('HFT');
  if (account.banMTGL === 1) bans.push('Martingale');
  md += `- **Banned Activities:** ${bans.length > 0 ? bans.join(', ') : 'None'}\n`;

  // User info
  if (user) {
    md += `\n### User Details\n\n`;
    md += `- **Name:** ${user.firstName} ${user.lastName}\n`;
    md += `- **Email:** ${user.email}\n`;
    md += `- **Country:** ${user.country}\n`;
    md += `- **KYC:** ${user.kycStatus} ${user.isKycVerified === 1 ? '(Verified)' : '(Not Verified)'}\n`;
    md += `- **Blacklisted:** ${user.isBlackListed === 1 ? 'YES' : 'No'}\n`;
    if (user.blackListReason) {
      md += `- **Blacklist Reason:** ${user.blackListReason}\n`;
    }
  }

  // Deductions
  if (deductions && deductions.totalDeductions > 0) {
    md += `\n### Deductions\n\n`;
    md += `- **Total:** ${$(deductions.totalDeductions)} across ${deductions.violationCount} violations\n`;
    for (const [type, amount] of Object.entries(deductions.breakdownByType)) {
      if (amount > 0) {
        md += `- ${getViolationLabel(type)}: ${$(amount)}\n`;
      }
    }
  }

  // Risk factors
  if (riskScore.reasons.length > 0) {
    md += `\n### Risk Factors\n\n`;
    for (const reason of riskScore.reasons) {
      md += `- ${reason}\n`;
    }
  }

  return md;
}

// ─── Violations Summary ──────────────────────────────────────

export function formatViolationsSummaryResponse(
  accounts: {
    accountId: string;
    login: string;
    totalDeductions: number;
    violationTypes: string[];
    breakdownByType: Record<string, number>;
  }[]
): string {
  const withViolations = accounts.filter((a) => a.totalDeductions > 0);

  if (withViolations.length === 0) {
    return `## Violations Summary\n\nNo violations found across pending payout accounts.`;
  }

  const totalDeductions = withViolations.reduce((s, a) => s + a.totalDeductions, 0);

  // Aggregate by type
  const byType: Record<string, { count: number; amount: number }> = {};
  for (const acct of withViolations) {
    for (const [type, amount] of Object.entries(acct.breakdownByType)) {
      if (amount <= 0) continue;
      if (!byType[type]) byType[type] = { count: 0, amount: 0 };
      byType[type].count++;
      byType[type].amount += amount;
    }
  }

  let md = `## Violations Summary\n\n`;

  md += `### At a Glance\n\n`;
  md += `- **Accounts with Violations:** ${withViolations.length}\n`;
  md += `- **Total Deductions:** ${$(totalDeductions)}\n`;
  md += `- **Violation Types:** ${Object.keys(byType).length}\n`;

  // By type
  md += `\n### Breakdown by Type\n\n`;
  const sorted = Object.entries(byType).sort((a, b) => b[1].amount - a[1].amount);
  for (const [type, data] of sorted) {
    md += `- **${getViolationLabel(type)}** — ${data.count} account(s), ${$(data.amount)}\n`;
  }

  // Top flagged
  md += `\n### Top Flagged Accounts\n\n`;
  const topAccounts = [...withViolations].sort((a, b) => b.totalDeductions - a.totalDeductions).slice(0, 10);
  for (let i = 0; i < topAccounts.length; i++) {
    const a = topAccounts[i];
    md += `**${i + 1}. Account ${a.accountId}** (Login: ${a.login})\n`;
    md += `- Deductions: **${$(a.totalDeductions)}**\n`;
    md += `- Types: ${a.violationTypes.map(getViolationLabel).join(', ')}\n\n`;
  }

  return md;
}

// ─── High Risk ───────────────────────────────────────────────

export function formatHighRiskResponse(
  accounts: {
    accountId: string;
    login: string;
    plan: string;
    riskScore: RiskScoreResult;
    payoutAmount: number;
    totalDeductions: number;
    isBlackListed: boolean;
  }[]
): string {
  const highRisk = accounts
    .filter((a) => a.riskScore.score >= 25)
    .sort((a, b) => b.riskScore.score - a.riskScore.score);

  if (highRisk.length === 0) {
    return `## High Risk Accounts\n\nNo high-risk accounts found. All accounts are within normal parameters.`;
  }

  let md = `## High Risk Accounts\n\n`;
  md += `**${highRisk.length}** accounts flagged above risk threshold\n\n`;

  // Critical callouts first
  const critical = highRisk.filter((a) => a.riskScore.level === 'critical');
  if (critical.length > 0) {
    md += `### Critical — Immediate Review Required\n\n`;
    for (const a of critical) {
      md += `> **Account ${a.accountId}** — Score: ${a.riskScore.score}/100\n`;
      md += `> ${a.riskScore.reasons.join(', ')}\n\n`;
    }
  }

  // Full list
  md += `### All Flagged Accounts\n\n`;
  for (let i = 0; i < Math.min(highRisk.length, 15); i++) {
    const a = highRisk[i];
    const level = a.riskScore.level.toUpperCase();
    md += `**${i + 1}. Account ${a.accountId}** — ${level} (${a.riskScore.score}/100)\n`;
    md += `- Plan: ${a.plan || '—'} | Payout: ${$(a.payoutAmount)} | Deductions: ${$(a.totalDeductions)}\n`;
    if (a.riskScore.reasons.length > 0) {
      md += `- Reasons: ${a.riskScore.reasons.slice(0, 3).join('; ')}\n`;
    }
    md += `\n`;
  }

  return md;
}

// ─── Security Check ──────────────────────────────────────────

export function formatSecurityCheckResponse(params: {
  blacklisted: { accountId: string; email: string; reason: string | null; payoutAmount: number }[];
  kycIssues: { accountId: string; email: string; kycStatus: string }[];
  anomalies: AnomalyFlag[];
}): string {
  const { blacklisted, kycIssues, anomalies } = params;

  let md = `## Security Check\n\n`;

  // Summary
  md += `### At a Glance\n\n`;
  md += `- **Blacklisted Users:** ${blacklisted.length}\n`;
  md += `- **KYC Issues:** ${kycIssues.length}\n`;
  md += `- **Anomalies Detected:** ${anomalies.length}\n`;

  // Blacklisted
  md += `\n### Blacklisted Users\n\n`;
  if (blacklisted.length > 0) {
    for (const b of blacklisted) {
      md += `- **Account ${b.accountId}** (${b.email})\n`;
      md += `  - Reason: ${b.reason || 'No reason provided'}\n`;
      md += `  - Pending Payout: ${$(b.payoutAmount)}\n`;
    }
  } else {
    md += `None found among pending payouts.\n`;
  }

  // KYC
  md += `\n### KYC Issues\n\n`;
  if (kycIssues.length > 0) {
    for (const k of kycIssues) {
      md += `- **Account ${k.accountId}** (${k.email}) — Status: ${k.kycStatus}\n`;
    }
  } else {
    md += `All users have verified KYC.\n`;
  }

  // Anomalies
  md += `\n### Anomalies\n\n`;
  if (anomalies.length > 0) {
    for (const a of anomalies) {
      const label = a.severity === 'critical' ? '**CRITICAL**' : '**WARNING**';
      md += `- ${label}: Account ${a.accountId} — ${a.description}\n`;
    }
  } else {
    md += `No anomalies detected.\n`;
  }

  return md;
}

// ─── Risk Score ──────────────────────────────────────────────

export function formatRiskScoreResponse(
  accountId: string,
  riskScore: RiskScoreResult,
  account: PlatformAccount | null,
  deductions: PlatformDeductions | null
): string {
  if (!account) {
    return `## Risk Score\n\nAccount **${accountId}** not found.`;
  }

  const badge =
    riskScore.level === 'critical' ? 'CRITICAL'
    : riskScore.level === 'high' ? 'HIGH'
    : riskScore.level === 'medium' ? 'MEDIUM'
    : 'LOW';

  let md = `## Risk Score — Account ${accountId}\n\n`;
  md += `**Score: ${riskScore.score}/100 (${badge})**\n\n`;

  if (riskScore.reasons.length > 0) {
    md += `### Contributing Factors\n\n`;
    for (const reason of riskScore.reasons) {
      md += `- ${reason}\n`;
    }
  } else {
    md += `No significant risk factors detected.\n`;
  }

  if (deductions && deductions.totalDeductions > 0) {
    md += `\n### Deductions\n\n`;
    md += `- **Total:** ${$(deductions.totalDeductions)} across ${deductions.violationCount} violations\n`;
  }

  return md;
}

// ─── Account Trades ──────────────────────────────────────────

export function formatAccountTradesResponse(
  accountId: string,
  stats: PlatformTradeStats | null,
  tradeCount: number
): string {
  if (!stats && tradeCount === 0) {
    return `## Trade History — Account ${accountId}\n\nNo trade data available. Trade data requires a foreign session and may not be accessible for all accounts.`;
  }

  let md = `## Trade History — Account ${accountId}\n\n`;
  md += `**${tradeCount}** total closed trades\n\n`;

  if (stats) {
    const { totals, winRates, ratios, daily } = stats;

    md += `### Performance Overview\n\n`;
    md += `- **Total P&L:** ${$(totals.totalPnL)}\n`;
    md += `- **Total Trades:** ${totals.totalTrades}\n`;
    md += `- **Win Rate:** ${pct(winRates.all * 100)}\n`;
    md += `- **Profit Factor:** ${ratios.profitFactor.toFixed(2)}\n`;
    md += `- **Sharpe Ratio:** ${ratios.sharpeRatio.toFixed(2)}\n`;

    md += `\n### Win/Loss Breakdown\n\n`;
    md += `- **Avg Trade P&L:** ${$(totals.averageTradePL)}\n`;
    md += `- **Largest Win:** ${$(totals.largestProfitTrade)}\n`;
    md += `- **Largest Loss:** ${$(totals.largestLossTrade)}\n`;
    md += `- **Avg Win:** ${$(totals.averageWin)}\n`;
    md += `- **Avg Loss:** ${$(totals.averageLoss)}\n`;

    md += `\n### Trading Activity\n\n`;
    md += `- **Trading Days:** ${daily.totalTradingDays}\n`;
    md += `- **Winning Days:** ${daily.winningDays} | Losing Days: ${daily.losingDays}\n`;
    md += `- **Avg Daily P&L:** ${$(daily.avgDailyPnl)}\n`;
    if (daily.largestProfitableDay) {
      md += `- **Best Day:** ${$(daily.largestProfitableDay.pnl)} on ${daily.largestProfitableDay.day}\n`;
    }
    if (daily.largestLosingDay) {
      md += `- **Worst Day:** ${$(daily.largestLosingDay.pnl)} on ${daily.largestLosingDay.day}\n`;
    }

    // Behavior analysis
    const profile = analyzeTradeProfile(stats);
    if (profile) {
      md += `\n### Behavior Analysis\n\n`;
      for (const line of profile.split('\n')) {
        if (line.trim()) md += `- ${line}\n`;
      }
    }

    // Top symbols
    if (stats.bySymbol.pnl.length > 0) {
      md += `\n### Top Symbols\n\n`;
      for (const s of stats.bySymbol.pnl.slice(0, 8)) {
        md += `- **${s.symbol}:** ${$(s.pnl)}\n`;
      }
    }
  }

  return md;
}

// ─── General Report ──────────────────────────────────────────

export function formatMorningReportResponse(report: MorningReportData): string {
  let md = `## General Risk Report\n\n`;
  md += `*Generated: ${new Date(report.generated_at).toLocaleString('en-US', { timeZone: 'America/New_York' })}*\n\n`;

  // Overview
  md += `### Overview\n\n`;
  md += `- **Pending Payouts:** ${report.pending_payouts.count} totaling ${$(report.pending_payouts.total_amount)}\n`;
  md += `- **Total Deductions:** ${$(report.deductions.total_amount)}\n`;
  md += `- **Accounts with Violations:** ${report.violations.accounts_with_violations}\n`;
  md += `- **High Risk Accounts:** ${report.security_flags.high_risk_count}\n`;
  md += `- **Blacklisted Users:** ${report.security_flags.blacklisted_users.length}\n`;
  md += `- **KYC Failures:** ${report.security_flags.kyc_failures}\n`;

  // Violations by type
  if (report.violations.total > 0) {
    md += `\n### Violations by Type\n\n`;
    for (const [type, count] of Object.entries(report.violations.by_type)) {
      md += `- **${getViolationLabel(type)}:** ${count} account(s)\n`;
    }
  }

  // Blacklisted alerts
  if (report.security_flags.blacklisted_users.length > 0) {
    md += `\n### Blacklisted User Alerts\n\n`;
    for (const bl of report.security_flags.blacklisted_users) {
      md += `- **Account ${bl.accountId}** (${bl.email}) — ${bl.reason || 'No reason provided'}\n`;
    }
  }

  // Top risk
  if (report.top_risk_accounts.length > 0) {
    md += `\n### Top Risk Accounts\n\n`;
    for (const a of report.top_risk_accounts.slice(0, 10)) {
      md += `- **Account ${a.accountId}** — Score: ${a.risk_score}/100\n`;
      if (a.reasons.length > 0) {
        md += `  - ${a.reasons.slice(0, 2).join('; ')}\n`;
      }
    }
  }

  // Top deductions
  if (report.deductions.top_accounts.length > 0) {
    md += `\n### Top Deductions\n\n`;
    for (const a of report.deductions.top_accounts.slice(0, 10)) {
      md += `- **Account ${a.accountId}** (Login: ${a.login}, ${a.plan}) — ${$(a.amount)}\n`;
    }
  }

  return md;
}

// ─── Account Violations ──────────────────────────────────────

export function formatAccountViolationsResponse(
  accountId: string,
  deductions: PlatformDeductions | null
): string {
  if (!deductions || deductions.totalDeductions === 0) {
    return `## Violations — Account ${accountId}\n\nNo violations or deductions found for this account.`;
  }

  let md = `## Violations — Account ${accountId}\n\n`;
  md += `- **Total Deductions:** ${$(deductions.totalDeductions)}\n`;
  md += `- **Violation Count:** ${deductions.violationCount}\n`;

  if (deductions.percentOfStartingBalance > 0) {
    md += `- **% of Starting Balance:** ${deductions.percentOfStartingBalance >= 100 ? '>100%' : pct(deductions.percentOfStartingBalance)}\n`;
  }
  if (deductions.percentOfTotalPL > 0) {
    md += `- **% of Total P&L:** ${deductions.percentOfTotalPL >= 100 ? '>100%' : pct(deductions.percentOfTotalPL)}\n`;
  }

  md += `\n### Breakdown\n\n`;
  for (const [type, amount] of Object.entries(deductions.breakdownByType)) {
    if (amount > 0) {
      md += `- **${getViolationLabel(type)}:** ${$(amount)}\n`;
    }
  }

  return md;
}

// ─── Deduction History ───────────────────────────────────────

export function formatDeductionHistoryResponse(
  events: { accountId: number; event: string; time: string; data: Record<string, any> }[]
): string {
  if (events.length === 0) {
    return `## Deduction History\n\nNo recent deduction events found.`;
  }

  let md = `## Recent Deduction Events\n\n`;
  md += `**${events.length}** events found\n\n`;

  for (const e of events.slice(0, 20)) {
    const time = new Date(e.time).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const details = e.data?.amount ? `${$(e.data.amount)}` : JSON.stringify(e.data).slice(0, 80);
    md += `- **${time}** — Account ${e.accountId}: ${details}\n`;
  }

  return md;
}

// ─── Fraud Scan ──────────────────────────────────────────────

export function formatFraudScanResponse(result: FraudHunterScanResult): string {
  let md = `## Fraud Hunter Scan Results\n\n`;

  md += `### Scan Summary\n\n`;
  md += `- **Detectors Run:** ${result.detectors_run.length} (${result.detectors_run.join(', ')})\n`;
  md += `- **Total Findings:** ${result.total_findings}\n`;
  md += `- **New Investigations:** ${result.new_investigations}\n`;
  md += `- **Scan Duration:** ${new Date(result.started_at).toLocaleTimeString('en-US')} — ${new Date(result.completed_at).toLocaleTimeString('en-US')}\n`;

  if (result.total_findings === 0) {
    md += `\nNo fraud indicators detected in this scan.\n`;
    return md;
  }

  md += `\n### Findings\n\n`;

  for (const detector of result.results) {
    if (detector.findings.length === 0) continue;

    md += `#### ${detector.fraud_type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}\n\n`;

    for (const finding of detector.findings) {
      const severity = finding.severity.toUpperCase();
      md += `**${severity}** — ${finding.title}\n`;
      md += `- Confidence: ${(finding.confidence_score * 100).toFixed(0)}%\n`;
      md += `- Accounts: ${finding.account_ids.join(', ')}\n`;
      md += `- Amount at Risk: ${$(finding.total_amount_at_risk)}\n`;
      md += `- Summary: ${finding.summary}\n`;
      if (finding.recommended_action) {
        md += `- Recommended: ${finding.recommended_action}\n`;
      }
      md += `\n`;
    }
  }

  return md;
}

// ─── Fraud Report ────────────────────────────────────────────

export function formatFraudReportResponse(investigations: FraudInvestigation[]): string {
  if (investigations.length === 0) {
    return `## Fraud Investigations\n\nNo open fraud investigations.`;
  }

  let md = `## Fraud Investigations\n\n`;

  // Count by type
  const byType: Record<string, number> = {};
  for (const inv of investigations) {
    byType[inv.fraud_type] = (byType[inv.fraud_type] || 0) + 1;
  }

  md += `### At a Glance\n\n`;
  md += `- **Open Investigations:** ${investigations.length}\n`;
  for (const [type, count] of Object.entries(byType)) {
    md += `- ${type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}: ${count}\n`;
  }

  md += `\n### Investigation Details\n\n`;

  for (const inv of investigations) {
    const shortId = inv.id.slice(0, 8);
    const severity = inv.severity.toUpperCase();
    const detected = new Date(inv.detected_at).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
    const typeLabel = inv.fraud_type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

    md += `**${shortId}** — ${typeLabel} (${severity})\n`;
    md += `- Status: ${inv.status}\n`;
    md += `- Accounts: ${inv.account_ids.length} (${inv.account_ids.slice(0, 5).join(', ')}${inv.account_ids.length > 5 ? '...' : ''})\n`;
    md += `- Amount at Risk: ${$(inv.total_amount_at_risk)}\n`;
    md += `- Detected: ${detected}\n`;
    md += `- ${inv.summary}\n`;
    md += `\n`;
  }

  return md;
}

// ─── Enforcement Queue ───────────────────────────────────────

export function formatEnforcementQueueResponse(items: EnforcementRecommendation[]): string {
  if (items.length === 0) {
    return `## Enforcement Queue\n\nNo pending enforcement actions.`;
  }

  let md = `## Enforcement Queue\n\n`;

  // Count by escalation level
  const byEscalation: Record<string, number> = {};
  for (const item of items) {
    byEscalation[item.escalation_level] = (byEscalation[item.escalation_level] || 0) + 1;
  }

  md += `### At a Glance\n\n`;
  md += `- **Pending Items:** ${items.length}\n`;
  for (const [level, count] of Object.entries(byEscalation)) {
    md += `- ${level.charAt(0).toUpperCase() + level.slice(1)}: ${count}\n`;
  }

  md += `\n### Pending Actions\n\n`;

  for (const item of items) {
    const escalation = item.escalation_level.toUpperCase();
    const created = new Date(item.created_at).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
    const typeLabel = item.violation_type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const isCritical = item.escalation_level === 'critical' || item.escalation_level === 'urgent';

    md += `${isCritical ? '> ' : ''}**Account ${item.account_id}** — ${typeLabel}\n`;
    md += `${isCritical ? '> ' : ''}- Action: ${item.action_type} | Amount: ${$(item.recommended_amount)}\n`;
    md += `${isCritical ? '> ' : ''}- Severity: ${item.severity_score}/100 | Escalation: ${escalation}\n`;
    md += `${isCritical ? '> ' : ''}- Created: ${created}\n`;
    md += `\n`;
  }

  return md;
}

// ─── Enforcement Summary ─────────────────────────────────────

export function formatEnforcementSummaryResponse(summary: EnforcementQueueSummary): string {
  let md = `## Enforcement Summary\n\n`;

  md += `### Overall Stats\n\n`;
  md += `- **Total Pending:** ${summary.total_pending}\n`;
  md += `- **Total Recommended Amount:** ${$(summary.total_recommended_amount)}\n`;
  md += `- **Oldest Pending:** ${summary.oldest_pending_at ? new Date(summary.oldest_pending_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'N/A'}\n`;

  md += `\n### By Escalation Level\n\n`;
  for (const [level, count] of Object.entries(summary.by_escalation)) {
    md += `- **${level.charAt(0).toUpperCase() + level.slice(1)}:** ${count}\n`;
  }

  md += `\n### By Violation Type\n\n`;
  if (Object.keys(summary.by_violation_type).length === 0) {
    md += `No violations in queue.\n`;
  } else {
    const sorted = Object.entries(summary.by_violation_type).sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sorted) {
      const label = type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      md += `- **${label}:** ${count}\n`;
    }
  }

  return md;
}

// ─── Repeat Offenders ────────────────────────────────────────

export function formatRepeatOffendersResponse(offenders: AccountViolationHistory[]): string {
  if (offenders.length === 0) {
    return `## Repeat Offenders\n\nNo repeat offenders tracked.`;
  }

  // Sort by escalation_tier DESC, total_count DESC
  const sorted = [...offenders].sort((a, b) => {
    if (b.escalation_tier !== a.escalation_tier) return b.escalation_tier - a.escalation_tier;
    return b.total_count - a.total_count;
  });

  let md = `## Repeat Offenders\n\n`;
  md += `**${sorted.length}** accounts with repeat violations\n\n`;

  for (const offender of sorted) {
    const typeLabel = offender.violation_type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const tierLabel =
      offender.escalation_tier >= 3 ? 'CRITICAL'
      : offender.escalation_tier >= 2 ? 'URGENT'
      : offender.escalation_tier >= 1 ? 'ELEVATED'
      : 'NORMAL';

    md += `**Account ${offender.account_id}** — ${typeLabel}\n`;
    md += `- Total Count: ${offender.total_count} | Last 30d: ${offender.count_last_30d}\n`;
    md += `- Total Deductions: ${$(offender.total_deduction_amount)}\n`;
    md += `- Escalation Tier: ${tierLabel} (${offender.escalation_tier})\n`;
    md += `\n`;
  }

  return md;
}
