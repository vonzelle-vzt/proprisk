import { brand } from '@/config/brand';
import type { AssetClass } from '@/lib/demo';
import { PROVIDER_META } from '@/lib/providers/registry';
import { VIOLATION_LABELS, severityFromDeduction } from '@/lib/providers/types';
import type { ProviderId, Severity } from '@/lib/providers/types';
import { FOREX_ACCOUNTS, type MockAccount } from './dataset.forex';
import { FUTURES_ACCOUNTS } from './dataset.futures';
import { CHALLENGE_ACCOUNTS, type MockChallengeAccount } from './dataset.challenges';

/**
 * Builders turn the coherent mock datasets into the exact response shape each
 * API route returns, per asset class. Pages/hooks are unchanged — they fetch
 * their normal route, which (in DEMO_MODE) returns one of these.
 */

function accountsFor(assetClass: AssetClass): MockAccount[] {
  return assetClass === 'futures' ? FUTURES_ACCOUNTS : FOREX_ACCOUNTS;
}

function labelFor(type: string): string {
  return (VIOLATION_LABELS as Record<string, string>)[type] || type;
}

function providerLabel(id: ProviderId): string {
  return PROVIDER_META[id]?.label ?? id;
}

function totalDeductions(a: MockAccount): number {
  return Object.values(a.deductionBreakdown).reduce((s, v) => s + v, 0);
}

function violationTypes(a: MockAccount): string[] {
  return Object.keys(a.deductionBreakdown).filter((t) => a.deductionBreakdown[t] > 0);
}

function severityOf(a: MockAccount): Severity {
  return severityFromDeduction(totalDeductions(a));
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Dashboard  (GET /api/platform/dashboard)
// ---------------------------------------------------------------------------

function toDashboardAccount(a: MockAccount, i: number) {
  const td = totalDeductions(a);
  const vtypes = violationTypes(a);
  const sizeUnit = a.provider && PROVIDER_META[a.provider]?.assetClass === 'futures' ? 'contracts' : 'lots';
  return {
    provider: a.provider,
    providerLabel: providerLabel(a.provider),
    sizeUnit,
    accountId: a.accountId,
    login: a.login,
    email: a.email,
    firstName: a.firstName,
    lastName: a.lastName,
    country: a.country,
    kycStatus: a.kycStatus,
    isBlackListed: a.isBlackListed,
    plan: a.plan,
    startingBalance: a.startingBalance,
    balance: a.balance,
    totalPnL: a.totalPnL,
    payoutAmount: a.payoutAmount,
    payoutRequestAmount: a.payoutAmount,
    payoutClientAmount: a.payoutAmount,
    profitSharePercentage: 80,
    payoutStatus: 'Pending',
    payoutRequested: isoDaysAgo((i % 14) + 1),
    totalDeductions: td,
    violationCount: vtypes.length,
    violationTypes: vtypes,
    violationLabels: vtypes.map(labelFor),
    deductionBreakdown: a.deductionBreakdown,
    severity: severityOf(a),
    canTrade: a.canTrade ?? true,
    maxDailyLossPct: a.maxDailyLossPct ?? 0,
    maxTrailingDrawdownPct: a.maxTrailingDrawdownPct ?? 0,
    maxPositionSize: a.maxPositionSize ?? 0,
    banNewsTrading: Boolean(a.banNewsTrading),
    banHFT: Boolean(a.banHFT),
    banMTGL: Boolean(a.banMTGL),
    tradedDays: a.tradedDays,
    numApprovedPayouts: i % 4,
    approvedPayouts: (i % 4) * 1200,
    consistencyAtRequest: 18 + (i % 10),
    consistencyRequired: 30,
    closedPnL: null,
    accountMetrics: {},
  };
}

export function buildDashboard(assetClass: AssetClass) {
  const accts = accountsFor(assetClass).map(toDashboardAccount);

  const withViolations = accts.filter((a) => a.totalDeductions > 0);
  const blacklisted = accts.filter((a) => a.isBlackListed);
  const totalPayoutAmount = accts.reduce((s, a) => s + a.payoutAmount, 0);
  const totalDed = accts.reduce((s, a) => s + a.totalDeductions, 0);

  const vTotals: Record<string, { count: number; amount: number }> = {};
  for (const a of accts) {
    for (const [t, amt] of Object.entries(a.deductionBreakdown)) {
      if (amt <= 0) continue;
      (vTotals[t] ||= { count: 0, amount: 0 }).count++;
      vTotals[t].amount += amt;
    }
  }
  const severityDistribution = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const a of withViolations) severityDistribution[a.severity]++;

  const planDist: Record<string, { count: number; totalPayout: number }> = {};
  for (const a of accts) {
    (planDist[a.plan] ||= { count: 0, totalPayout: 0 }).count++;
    planDist[a.plan].totalPayout += a.payoutAmount;
  }
  const countryDist: Record<string, number> = {};
  for (const a of accts) countryDist[a.country] = (countryDist[a.country] || 0) + 1;

  return {
    summary: {
      totalPendingPayouts: accts.length,
      totalPayoutAmount,
      totalDeductions: totalDed,
      accountsWithViolations: withViolations.length,
      blacklistedAccounts: blacklisted.length,
      avgPayoutAmount: accts.length ? totalPayoutAmount / accts.length : 0,
      avgDeductionPerViolatedAccount: withViolations.length ? totalDed / withViolations.length : 0,
    },
    violationTypeBreakdown: Object.entries(vTotals)
      .map(([type, d]) => ({ type, label: labelFor(type), count: d.count, amount: d.amount }))
      .sort((a, b) => b.amount - a.amount),
    severityDistribution,
    planDistribution: Object.entries(planDist)
      .map(([plan, d]) => ({ plan, ...d }))
      .sort((a, b) => b.count - a.count),
    countryDistribution: Object.entries(countryDist)
      .map(([country, count]) => ({ country, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15),
    topFlaggedAccounts: [...withViolations].sort((a, b) => b.totalDeductions - a.totalDeductions).slice(0, 20),
    topPayouts: [...accts].sort((a, b) => b.payoutAmount - a.payoutAmount).slice(0, 20),
    allAccounts: accts,
  };
}

// ---------------------------------------------------------------------------
// Payouts  (GET /api/payouts)
// ---------------------------------------------------------------------------

function paginate<T>(items: T[], page: number, perPage: number) {
  const total = items.length;
  const start = (page - 1) * perPage;
  return {
    data: items.slice(start, start + perPage),
    meta: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) },
  };
}

export function buildPayouts(assetClass: AssetClass, page = 1, perPage = 20, search = '') {
  let accts = accountsFor(assetClass);
  if (search) {
    const q = search.toLowerCase();
    accts = accts.filter(
      (a) => a.login.includes(q) || a.email.toLowerCase().includes(q) || `${a.firstName} ${a.lastName}`.toLowerCase().includes(q)
    );
  }
  const records = accts.map((a, i) => {
    const td = totalDeductions(a);
    const vtypes = violationTypes(a);
    return {
      id: a.accountId,
      _id: a.accountId,
      accountId: a.accountId,
      orderNumber: `PO-${a.accountId}`,
      login: a.login,
      email: a.email,
      firstName: a.firstName,
      lastName: a.lastName,
      country: a.country,
      kycStatus: a.kycStatus,
      kycCountry: a.country,
      ipMismatch: i % 9 === 0,
      isBlackListed: a.isBlackListed,
      plan: a.plan,
      provider: a.provider,
      providerLabel: providerLabel(a.provider),
      startingBalance: a.startingBalance,
      accountSize: a.startingBalance,
      balance: a.balance,
      totalPnL: a.totalPnL,
      amount: a.payoutAmount,
      clientAmount: a.payoutAmount,
      profitSharePercentage: 80,
      dateRequested: isoDaysAgo((i % 14) + 1),
      tradedDays: a.tradedDays,
      banNewsTrading: Boolean(a.banNewsTrading),
      banHFT: Boolean(a.banHFT),
      banMTGL: Boolean(a.banMTGL),
      numApprovedPayouts: i % 4,
      approvedPayouts: (i % 4) * 1200,
      platformViolations: vtypes,
      platformDeductions:
        td > 0
          ? {
              totalDeductions: td,
              breakdownByType: a.deductionBreakdown,
              violationCount: vtypes.length,
              percentOfStartingBalance: a.startingBalance > 0 ? (td / a.startingBalance) * 100 : 0,
              percentOfTotalPL: a.totalPnL > 0 ? (td / a.totalPnL) * 100 : 0,
            }
          : undefined,
      preApprovedStatus: 0,
      status: 'Pending',
      notes: '',
    };
  });
  return paginate(records, page, perPage);
}

export function buildPayoutSummary(assetClass: AssetClass) {
  const accts = accountsFor(assetClass);
  return {
    total: accts.length,
    ipFlags: accts.filter((_, i) => i % 9 === 0).length,
    investigations: accts.filter((a) => severityOf(a) === 'critical').length,
    totalClientAmount: accts.reduce((s, a) => s + a.payoutAmount, 0),
    violationFlags: accts.filter((a) => totalDeductions(a) > 0).length,
    totalDeductions: accts.reduce((s, a) => s + totalDeductions(a), 0),
  };
}

// ---------------------------------------------------------------------------
// Violations  (GET /api/platform/violations)  &  Deductions (GET /api/platform/deductions)
// ---------------------------------------------------------------------------

function violationRows(assetClass: AssetClass) {
  const rows: any[] = [];
  for (const a of accountsFor(assetClass)) {
    for (const [type, amount] of Object.entries(a.deductionBreakdown)) {
      if (amount <= 0) continue;
      rows.push({
        id: `${a.accountId}-${type}`,
        login: a.login,
        accountId: a.accountId,
        email: a.email,
        firstName: a.firstName,
        lastName: a.lastName,
        country: a.country,
        kycStatus: a.kycStatus,
        plan: a.plan,
        provider: a.provider,
        providerLabel: providerLabel(a.provider),
        startingBalance: a.startingBalance,
        violationType: type,
        violationLabel: labelFor(type),
        severity: severityFromDeduction(amount),
        totalDeduction: amount,
        deductionAmount: amount,
        flaggedTradeCount: 1 + (amount % 5),
        detectedAt: isoDaysAgo((rows.length % 20) + 1),
        deductionDate: isoDaysAgo((rows.length % 20) + 1),
        deductionNote: `${labelFor(type)} deduction on account ${a.login}`,
        explanation: `${labelFor(type)} violation on account ${a.login} (${a.plan}). Deduction: $${amount.toFixed(2)} of $${a.startingBalance.toLocaleString()} starting balance.`,
        banNewsTrading: Boolean(a.banNewsTrading),
        banHFT: Boolean(a.banHFT),
        banMTGL: Boolean(a.banMTGL),
        tradedDays: a.tradedDays,
      });
    }
  }
  return rows;
}

function filterRows(rows: any[], search: string, violationType: string) {
  let out = rows;
  if (search) {
    const q = search.toLowerCase();
    out = out.filter((r) => r.login.includes(q) || r.accountId.includes(q) || r.email.toLowerCase().includes(q) || `${r.firstName} ${r.lastName}`.toLowerCase().includes(q));
  }
  if (violationType) out = out.filter((r) => r.violationType === violationType);
  return out;
}

function pageRows(rows: any[], page: number, perPage: number) {
  const total = rows.length;
  const start = (page - 1) * perPage;
  return { data: rows.slice(start, start + perPage), total, page, per_page: perPage, total_pages: Math.max(1, Math.ceil(total / perPage)) };
}

export function buildViolations(assetClass: AssetClass, page = 1, perPage = 100, search = '', violationType = '') {
  return pageRows(filterRows(violationRows(assetClass), search, violationType), page, perPage);
}

export function buildDeductions(assetClass: AssetClass, page = 1, perPage = 100, search = '', violationType = '') {
  return pageRows(filterRows(violationRows(assetClass), search, violationType), page, perPage);
}

export function buildDeductionsSummary(assetClass: AssetClass) {
  const rows = violationRows(assetClass);
  const byType = new Map<string, { count: number; total_amount: number }>();
  for (const r of rows) {
    const e = byType.get(r.violationType) || { count: 0, total_amount: 0 };
    e.count++;
    e.total_amount += r.deductionAmount;
    byType.set(r.violationType, e);
  }
  const total_amount = rows.reduce((s, r) => s + r.deductionAmount, 0);
  const detailList = rows.map((r) => ({
    login: r.login,
    accountId: r.accountId,
    plan: r.plan,
    violationType: r.violationType,
    violationLabel: r.violationLabel,
    amount: r.deductionAmount,
  }));
  return {
    time_series: [],
    breakdowns: {
      by_violation_type: Array.from(byType.entries()).map(([type, s]) => ({ type: labelFor(type), count: s.count, total_amount: s.total_amount })),
      by_account_size: [],
      by_challenge_type: [],
    },
    totals: { count: rows.length, total_amount },
    comparison: {
      platform_reported: Math.round(total_amount * 1.12),
      platform_count: rows.length + 3,
      calculated: total_amount,
      calculated_count: rows.length,
      difference: Math.round(total_amount * 0.12),
      difference_count: 3,
      news_removed: 3,
      flagged_deductions: detailList.filter((d) => d.violationType === 'news').slice(0, 3),
      platform_details: detailList,
      analysis_details: detailList,
    },
  };
}

// ---------------------------------------------------------------------------
// Enforcement  (GET /api/enforcement/queue, /summary)
// ---------------------------------------------------------------------------

const ACTION_TYPES = ['deduction', 'payout_hold', 'account_restriction', 'escalation', 'warning'] as const;
const ESC_LEVELS = ['normal', 'elevated', 'urgent', 'critical'] as const;

export function buildEnforcementQueue(assetClass: AssetClass) {
  const data: any[] = [];
  const accts = accountsFor(assetClass).filter((a) => totalDeductions(a) > 0);
  accts.forEach((a, i) => {
    const vtypes = violationTypes(a);
    const type = vtypes[0] || 'overleveraging';
    const amount = a.deductionBreakdown[type] || 0;
    const sev = severityFromDeduction(amount);
    const esc = sev === 'critical' ? 'critical' : sev === 'high' ? 'urgent' : sev === 'medium' ? 'elevated' : 'normal';
    data.push({
      id: `ENF-${a.accountId}`,
      account_id: a.accountId,
      violation_id: `${a.accountId}-${type}`,
      violation_type: type,
      action_type: ACTION_TYPES[i % ACTION_TYPES.length],
      status: 'pending',
      severity_score: Math.min(100, Math.round((amount / 10) + 30)),
      escalation_level: esc,
      recommended_amount: amount,
      recommendation_reason: `${labelFor(type)} detected on ${providerLabel(a.provider)} account ${a.login}.`,
      recommendation_details: {
        base_amount: amount,
        repeat_multiplier: 1,
        severity_factors: [labelFor(type)],
        suggested_restrictions: esc === 'critical' ? ['suspend', 'flatten'] : ['restrict'],
        account_context: { plan: a.plan, balance: a.balance, total_prior_deductions: 0 },
      },
      prior_violation_count: i % 3,
      repeat_multiplier: 1,
      decided_by: null,
      decided_at: null,
      decision_notes: null,
      executed_at: null,
      execution_result: null,
      expires_at: isoDaysAgo(-7),
      created_at: isoDaysAgo((i % 10) + 1),
      updated_at: isoDaysAgo((i % 10) + 1),
      reviewer_status: i % 3 === 0 ? 'deduction_confirmed' : i % 3 === 1 ? 'pending_deduction' : null,
      reviewer_notes: null,
      reviewed_at: i % 3 === 2 ? null : isoDaysAgo(i % 5),
      email_sent_at: i % 2 === 0 ? isoDaysAgo(i % 5) : null,
      payout_ref: `PO-${a.accountId}`,
    });
  });
  return { data };
}

export function buildEnforcementSummary(assetClass: AssetClass) {
  const { data: pending } = buildEnforcementQueue(assetClass);
  const by_escalation: Record<string, number> = { normal: 0, elevated: 0, urgent: 0, critical: 0 };
  const by_action_type: Record<string, number> = { deduction: 0, payout_hold: 0, account_restriction: 0, escalation: 0, warning: 0 };
  const by_violation_type: Record<string, number> = {};
  const by_reviewer_status: Record<string, number> = {};
  let total_recommended_amount = 0;
  let oldest_pending_at: string | null = null;
  for (const r of pending) {
    by_escalation[r.escalation_level]++;
    by_action_type[r.action_type]++;
    by_violation_type[r.violation_type] = (by_violation_type[r.violation_type] || 0) + 1;
    if (r.reviewer_status) by_reviewer_status[r.reviewer_status] = (by_reviewer_status[r.reviewer_status] || 0) + 1;
    total_recommended_amount += r.recommended_amount;
    if (!oldest_pending_at || r.created_at < oldest_pending_at) oldest_pending_at = r.created_at;
  }
  return {
    data: { total_pending: pending.length, by_escalation, by_action_type, by_violation_type, total_recommended_amount, oldest_pending_at, by_reviewer_status },
  };
}

// ---------------------------------------------------------------------------
// History  (GET /api/history, /summary)
// ---------------------------------------------------------------------------

export function buildHistory(assetClass: AssetClass, page = 1, perPage = 20, search = '') {
  let accts = accountsFor(assetClass);
  if (search) {
    const q = search.toLowerCase();
    accts = accts.filter((a) => a.login.includes(q) || a.email.toLowerCase().includes(q));
  }
  // ~70% of accounts have a decided payout in history
  const records = accts
    .filter((_, i) => i % 10 < 7)
    .map((a, i) => {
      const td = totalDeductions(a);
      const approved = td < 250 && !a.isBlackListed;
      return {
        id: `HIST-${a.accountId}`,
        platformPayoutId: `PO-${a.accountId}`,
        platformAccountId: a.accountId,
        platformOrderId: `ORD-${a.accountId}`,
        login: a.login,
        decision: approved ? 'approved' : 'rejected',
        decidedBy: 'Risk Management System',
        decidedAt: isoDaysAgo((i % 30) + 1),
        decisionNotes: approved ? 'Cleared — no material violations.' : 'Rejected — risk violations exceeded threshold.',
        amount: a.payoutAmount,
        clientAmount: a.payoutAmount,
        profitSharePct: 80,
        plan: a.plan,
        provider: a.provider,
        providerLabel: providerLabel(a.provider),
        dateRequested: isoDaysAgo((i % 30) + 3),
        balance: a.balance,
        totalPnl: a.totalPnL,
        startingBalance: a.startingBalance,
        tradedDays: a.tradedDays,
        email: a.email,
        firstName: a.firstName,
        lastName: a.lastName,
        country: a.country,
        kycStatus: a.kycStatus,
        isBlacklisted: a.isBlackListed,
        violationsList: violationTypes(a),
        deductionsTotal: td,
        deductionsViolationCount: violationTypes(a).length,
        deductionsByType: a.deductionBreakdown,
        fullSnapshot: {} as any,
        createdAt: isoDaysAgo((i % 30) + 1),
      };
    });
  return paginate(records, page, perPage);
}

export function buildHistorySummary(assetClass: AssetClass) {
  const { data } = buildHistory(assetClass, 1, 1000);
  const approved = data.filter((d: any) => d.decision === 'approved');
  const rejected = data.filter((d: any) => d.decision === 'rejected');
  const totalPaid = approved.reduce((s: number, d: any) => s + (d.clientAmount || 0), 0);
  return {
    totalApproved: approved.length,
    totalRejected: rejected.length,
    totalAmountPaid: totalPaid,
    avgPayout: approved.length ? totalPaid / approved.length : 0,
    totalDeductions: data.reduce((s: number, d: any) => s + d.deductionsTotal, 0),
  };
}

// ---------------------------------------------------------------------------
// Reviewer  (GET /api/reviewer/runs)
// ---------------------------------------------------------------------------

export function buildReviewerRuns(assetClass: AssetClass) {
  const queue = buildEnforcementQueue(assetClass).data;
  const cases = queue
    .filter((q) => q.reviewer_status)
    .map((q) => ({
      id: q.id,
      account_id: q.account_id,
      violation_type: q.violation_type,
      action_type: q.action_type,
      recommended_amount: q.recommended_amount,
      status: q.status,
      reviewer_status: q.reviewer_status,
      reviewer_notes: q.reviewer_notes,
      reviewed_at: q.reviewed_at,
      created_at: q.created_at,
      severity_score: q.severity_score,
      escalation_level: q.escalation_level,
      recommendation_details: q.recommendation_details,
      recommendation_reason: q.recommendation_reason,
      prior_violation_count: q.prior_violation_count,
      repeat_multiplier: q.repeat_multiplier,
      decided_by: q.decided_by,
      decided_at: q.decided_at,
      execution_result: q.execution_result,
      payout_ref: q.payout_ref,
    }));
  const runs = [0, 1, 2].map((n) => {
    const confirmed = cases.filter((c) => c.reviewer_status === 'deduction_confirmed').length;
    const pending = cases.filter((c) => c.reviewer_status === 'pending_deduction').length;
    return {
      run_id: `RUN-${1000 + n}`,
      started_at: isoDaysAgo(n + 1),
      completed_at: isoDaysAgo(n + 1),
      total_cases: cases.length,
      confirmed,
      pending_deduction: pending,
      errors: 0,
      skipped: 0,
      platform_healthy: true,
    };
  });
  const stats = {
    total_reviewed: cases.length,
    confirmed: cases.filter((c) => c.reviewer_status === 'deduction_confirmed').length,
    pending_deduction: cases.filter((c) => c.reviewer_status === 'pending_deduction').length,
    errors: 0,
    total_runs: runs.length,
    last_run: runs[0] ?? null,
  };
  return { runs, cases, stats };
}

// ---------------------------------------------------------------------------
// Emails  (GET /api/emails)
// ---------------------------------------------------------------------------

export function buildEmails(assetClass: AssetClass, page = 1, perPage = 20, search = '') {
  let rows = violationRows(assetClass).map((r, i) => ({
    id: `EM-${r.id}`,
    account_id: r.accountId,
    challenge_account_id: null,
    recipient: r.email,
    subject: `[Risk Management] ${r.violationLabel} Violation - Account ${r.login}`,
    body: `<div style="font-family:Inter,Arial,sans-serif"><h2>${r.violationLabel} Policy Violation</h2><p>Dear ${r.firstName} ${r.lastName},</p><p>Your account <strong>${r.login}</strong> was flagged for a ${r.violationLabel} violation. Deduction: $${r.deductionAmount.toFixed(2)}.</p><p>— ${brand.productName} Platform, ${brand.companyName}</p></div>`,
    template_type: r.violationType,
    sent_by: 'system',
    sent_by_name: 'Risk Management System',
    sent_at: r.detectedAt,
    status: i % 11 === 0 ? 'failed' : 'sent',
  }));
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter((e) => e.recipient.toLowerCase().includes(q) || e.subject.toLowerCase().includes(q));
  }
  const total = rows.length;
  const start = (page - 1) * perPage;
  return { data: rows.slice(start, start + perPage), total, page, per_page: perPage, total_pages: Math.max(1, Math.ceil(total / perPage)) };
}

// ---------------------------------------------------------------------------
// Account detail  (GET /api/accounts/[login])
// ---------------------------------------------------------------------------

export function buildAccount(login: string) {
  const all = [...FOREX_ACCOUNTS, ...FUTURES_ACCOUNTS];
  const a = all.find((x) => x.login === login || x.accountId === login) || all[0];
  const vtypes = violationTypes(a);
  return {
    login: a.login,
    accountId: a.accountId,
    email: a.email,
    firstName: a.firstName,
    lastName: a.lastName,
    country: a.country,
    kycStatus: a.kycStatus,
    plan: a.plan,
    provider: a.provider,
    providerLabel: providerLabel(a.provider),
    startingBalance: a.startingBalance,
    balance: a.balance,
    totalPnL: a.totalPnL,
    tradedDays: a.tradedDays,
    isBlackListed: a.isBlackListed,
    violations: vtypes.map((t) => ({
      violationType: t,
      violationLabel: labelFor(t),
      deductionAmount: a.deductionBreakdown[t],
      detectedAt: isoDaysAgo(3),
    })),
    deductions: vtypes.map((t) => ({ violationType: t, amount: a.deductionBreakdown[t], detectedAt: isoDaysAgo(3) })),
    emails: vtypes.map((t) => ({ subject: `[Risk Management] ${labelFor(t)} Violation - Account ${a.login}`, status: 'sent', sent_at: isoDaysAgo(3) })),
  };
}

// ---------------------------------------------------------------------------
// Challenges  (dashboard/challenges, challenges/analyze, violations/deductions/challenges)
// ---------------------------------------------------------------------------

function challengeTrades(a: MockChallengeAccount) {
  const symbols = ['EURUSD', 'XAUUSD', 'GBPJPY', 'US30', 'NAS100'];
  const vtypes = Object.keys(a.deduction_breakdown);
  return Array.from({ length: Math.max(4, vtypes.length + 2) }, (_, i) => {
    const profit = Math.round((i % 2 === 0 ? 1 : -1) * (120 + i * 41));
    return {
      _id: `CT-${a.account_id}-${i}`,
      position: `${a.account_id}${i}`,
      trdSymbol: symbols[i % symbols.length],
      side: i % 2 === 0 ? 'Buy' : 'Sell',
      lots: Number((0.2 + i * 0.1).toFixed(1)),
      openTime: isoDaysAgo(9 - i),
      closeTime: isoDaysAgo(9 - i),
      openPrice: 100 + i,
      closePrice: 101 + i,
      profit,
      commission: -2,
      swap: 0,
      duration: 0.05 + i * 0.1,
    };
  });
}

/** MockChallengeAccount → CachedChallengeAccount (analysis / violations / deductions). */
function toCached(a: MockChallengeAccount, i: number) {
  const vtypes = Object.keys(a.deduction_breakdown);
  const violation_details: Record<string, { trade_id: string; explanation: string; amount: number }[]> = {};
  vtypes.forEach((t, k) => {
    violation_details[t] = [{ trade_id: `CT-${a.account_id}-${k}`, explanation: `${labelFor(t)} pattern detected`, amount: a.deduction_breakdown[t] }];
  });
  return {
    account_id: a.account_id,
    login: a.login,
    email: a.email,
    first_name: a.first_name,
    last_name: a.last_name,
    country: a.country,
    plan: a.plan,
    plan_type: a.plan_type,
    phase: a.phase,
    phase_label: a.phase_label,
    starting_balance: a.starting_balance,
    balance: a.balance,
    equity: a.equity,
    total_deductions: a.total_deductions,
    violation_count: a.violation_count,
    violation_types: a.violation_types,
    violation_labels: a.violation_labels,
    deduction_breakdown: a.deduction_breakdown,
    violation_details,
    severity: a.severity,
    flagged_trade_count: a.flagged_trade_count,
    ban_news_trading: a.ban_news_trading,
    ban_hft: a.ban_hft,
    ban_mtgl: a.ban_mtgl,
    traded_days: a.traded_days,
    has_news_addon: a.has_news_addon,
    added_at: isoDaysAgo((i % 30) + 5),
    pass_date: isoDaysAgo((i % 20) + 1),
    processed_at: isoDaysAgo((i % 20) + 1),
    trades: challengeTrades(a),
    news_events: [],
  };
}

const TYPE_LABELS: Record<number, string> = { 1: '1-Step', 2: '2-Step', 3: 'Instant' };

/** MockChallengeAccount → PassedChallengeAccount (dashboard list). */
function toPassedAccount(a: MockChallengeAccount, i: number) {
  const isMulti = a.type === 2;
  return {
    accountId: Number(a.account_id),
    login: Number(a.login),
    userId: a.userId,
    email: a.email,
    firstName: a.first_name,
    lastName: a.last_name,
    country: a.country,
    planName: a.plan,
    type: a.type,
    typeLabel: TYPE_LABELS[a.type] || `${a.type}-Step`,
    phase: a.phase,
    startingBalance: a.starting_balance,
    lastBalance: a.balance,
    lastEquity: a.equity,
    tradedDays: a.traded_days,
    banNewsTrading: a.ban_news_trading,
    banHFT: a.ban_hft,
    banMTGL: a.ban_mtgl,
    parentId: isMulti ? Number(a.account_id) - 1 : null,
    childId: null,
    addedUTC: isoDaysAgo((i % 30) + 5),
    analysisStatus: 'cached' as const,
    phase1: isMulti
      ? {
          accountId: Number(a.account_id) - 1,
          login: Number(a.login) - 1,
          planName: a.plan.replace('2 Step', '1 Step'),
          startingBalance: a.starting_balance,
          lastBalance: Math.round(a.starting_balance * 1.08),
          lastEquity: Math.round(a.starting_balance * 1.08),
          tradedDays: Math.max(3, a.traded_days - 4),
          lastUpdatedUTC: isoDaysAgo((i % 30) + 8),
          analysisStatus: 'cached' as const,
        }
      : null,
  };
}

export function buildChallengeDashboard(page = 1, search = '') {
  let accts = CHALLENGE_ACCOUNTS;
  if (search) {
    const q = search.toLowerCase();
    accts = accts.filter((a) => a.login.includes(q) || a.account_id.includes(q) || a.email.toLowerCase().includes(q) || `${a.first_name} ${a.last_name}`.toLowerCase().includes(q));
  }
  const pageSize = 25;
  const start = (page - 1) * pageSize;
  const pageAccts = accts.slice(start, start + pageSize);

  // Global stats across the whole passed-challenge book.
  const withViolations = CHALLENGE_ACCOUNTS.filter((a) => a.total_deductions > 0);
  const vTotals: Record<string, { count: number; amount: number }> = {};
  for (const a of CHALLENGE_ACCOUNTS) {
    for (const [t, amt] of Object.entries(a.deduction_breakdown)) {
      if (amt <= 0) continue;
      (vTotals[t] ||= { count: 0, amount: 0 }).count++;
      vTotals[t].amount += amt;
    }
  }
  const stats = {
    analyzedCount: CHALLENGE_ACCOUNTS.length,
    withViolations: withViolations.length,
    totalDeductions: CHALLENGE_ACCOUNTS.reduce((s, a) => s + a.total_deductions, 0),
    violationBreakdown: Object.entries(vTotals)
      .map(([type, d]) => ({ type, label: labelFor(type), count: d.count, amount: d.amount }))
      .sort((a, b) => b.amount - a.amount),
  };

  return {
    accounts: pageAccts.map((a, i) => toPassedAccount(a, start + i)),
    page,
    pageSize: pageAccts.length,
    hasMore: start + pageSize < accts.length,
    totalAccounts: accts.length,
    stats,
  };
}

export function buildChallengeAnalysis(accountId: string) {
  const idx = CHALLENGE_ACCOUNTS.findIndex((a) => a.account_id === accountId || a.login === accountId);
  const a = idx >= 0 ? CHALLENGE_ACCOUNTS[idx] : CHALLENGE_ACCOUNTS[0];
  const i = idx >= 0 ? idx : 0;
  const phase2 = toCached(a, i);
  const phase1 = a.type === 2
    ? { ...toCached(a, i), account_id: `${Number(a.account_id) - 1}`, login: `${Number(a.login) - 1}`, phase: 1, phase_label: 'Phase 1', total_deductions: 0, violation_count: 0, violation_types: [], violation_labels: [], deduction_breakdown: {}, violation_details: {} }
    : null;
  return { phase2, phase1, source: 'cache' as const };
}

function challengeRows(search: string, violationType: string) {
  const rows: any[] = [];
  CHALLENGE_ACCOUNTS.forEach((a, idx) => {
    for (const [type, amount] of Object.entries(a.deduction_breakdown)) {
      if (amount <= 0) continue;
      rows.push({
        id: `${a.account_id}-${type}`,
        login: a.login,
        accountId: a.account_id,
        email: a.email,
        firstName: a.first_name,
        lastName: a.last_name,
        country: a.country,
        plan: a.plan,
        startingBalance: a.starting_balance,
        violationType: type,
        violationLabel: labelFor(type),
        severity: severityFromDeduction(amount),
        flaggedTradeCount: 1 + (amount % 4),
        totalDeduction: amount,
        deductionAmount: amount,
        detectedAt: isoDaysAgo((idx % 20) + 1),
        deductionDate: isoDaysAgo((idx % 20) + 1),
        explanation: `${labelFor(type)} violation on challenge account ${a.login} (${a.plan}). Deduction: $${amount.toFixed(2)}.`,
      });
    }
  });
  let out = rows;
  if (search) {
    const q = search.toLowerCase();
    out = out.filter((r) => r.login.includes(q) || r.accountId.includes(q) || r.email.toLowerCase().includes(q) || `${r.firstName} ${r.lastName}`.toLowerCase().includes(q));
  }
  if (violationType) out = out.filter((r) => r.violationType === violationType);
  return out;
}

export function buildChallengeViolations(page = 1, perPage = 100, search = '', violationType = '') {
  const rows = challengeRows(search, violationType);
  const total = rows.length;
  const start = (page - 1) * perPage;
  return { data: rows.slice(start, start + perPage), total, page, per_page: perPage, total_pages: Math.max(1, Math.ceil(total / perPage)) };
}

export const buildChallengeDeductions = buildChallengeViolations;

/**
 * One mock violation row by its id, across BOTH asset classes.
 *
 * `buildViolations()` is paginated and asset-class scoped, which is the wrong
 * shape for a caller that has an id and nothing else (the per-violation report
 * routes, which receive `/api/violations/<id>/report` and no `assetClass`).
 * Ids are `${accountId}-${violationType}` — see `violationRows`.
 */
export function buildViolationById(id: string) {
  for (const assetClass of ['forex', 'futures'] as AssetClass[]) {
    const row = violationRows(assetClass).find((r) => r.id === id);
    if (row) return { ...row, assetClass };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Violation detail  (GET /api/platform/violations/[accountId])
// ---------------------------------------------------------------------------

export function buildViolationDetail(accountId: string) {
  const all = [...FOREX_ACCOUNTS, ...FUTURES_ACCOUNTS];
  const a = all.find((x) => x.accountId === accountId || x.login === accountId) || FOREX_ACCOUNTS[0];
  const futures = PROVIDER_META[a.provider]?.assetClass === 'futures';
  const symbols = futures ? ['ES', 'NQ', 'CL', 'GC'] : ['EURUSD', 'XAUUSD', 'GBPJPY', 'US30'];
  const vtypes = violationTypes(a);
  const td = totalDeductions(a);

  const violationBreakdown = vtypes.map((t) => ({ type: t, label: labelFor(t), amount: a.deductionBreakdown[t] }));

  const flaggedTrades = vtypes.map((t, i) => {
    const profit = Math.round(150 + i * 90);
    return {
      tradeId: `T-${a.accountId}-${i}`,
      type: t,
      typeLabel: labelFor(t),
      explanation: `${labelFor(t)} pattern detected on ${symbols[i % symbols.length]}`,
      deductionAmount: a.deductionBreakdown[t],
      symbol: symbols[i % symbols.length],
      side: i % 2 === 0 ? 'buy' : 'sell',
      lots: futures ? 1 + (i % 3) : Number((0.2 + i * 0.1).toFixed(1)),
      openTime: isoDaysAgo(7 - i),
      closeTime: isoDaysAgo(7 - i),
      openPrice: 100 + i,
      closePrice: 101 + i,
      duration: 0.05 + i * 0.1,
      profit,
      commission: -2,
      swap: 0,
      stopLoss: 0,
      takeProfit: 0,
    };
  });

  const deductionsByType: Record<string, number> = {};
  for (const t of vtypes) deductionsByType[t] = a.deductionBreakdown[t];

  return {
    accountId: a.accountId,
    login: a.login,
    email: a.email,
    firstName: a.firstName,
    lastName: a.lastName,
    country: a.country,
    kycStatus: a.kycStatus,
    isBlackListed: a.isBlackListed,
    plan: a.plan,
    startingBalance: a.startingBalance,
    balance: a.balance,
    tradedDays: a.tradedDays,
    banNewsTrading: Boolean(a.banNewsTrading),
    banHFT: Boolean(a.banHFT),
    banMTGL: Boolean(a.banMTGL),
    numApprovedPayouts: 0,
    approvedPayouts: 0,
    consistencyAtRequest: 22,
    consistencyRequired: 30,
    totalDeductions: td,
    violationCount: vtypes.length,
    violationBreakdown,
    deductionEvents: [],
    accountMetrics: {},
    trades: flaggedTrades.map((t) => ({ ...t, _id: t.tradeId, trdSymbol: t.symbol })),
    tradeTotal: flaggedTrades.length,
    tradeStats: null,
    flaggedTrades,
    tradeAnalysisSummary: {
      totalDeductions: td,
      violationTypeCount: Object.fromEntries(vtypes.map((t) => [t, 1])),
      violatingTradeCount: flaggedTrades.length,
      deductionsByType,
    },
    newsRechecked: false,
  };
}

// ---------------------------------------------------------------------------
// Interactive POST stubs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Live breach alerts  (GET /api/alerts)
// ---------------------------------------------------------------------------

export function buildAlerts(assetClass: AssetClass) {
  const alerts: any[] = [];
  accountsFor(assetClass).forEach((a, i) => {
    const vtypes = violationTypes(a);
    // Futures hard-breach: locked from trading.
    if (a.canTrade === false) {
      const t = vtypes.find((v) => v === 'trailing_drawdown' || v === 'daily_loss') || vtypes[0] || 'trailing_drawdown';
      alerts.push({
        id: `ALERT-${a.accountId}-breach`,
        accountId: a.accountId,
        login: a.login,
        provider: a.provider,
        providerLabel: providerLabel(a.provider),
        assetClass,
        type: t,
        label: labelFor(t),
        severity: 'critical',
        message: `${labelFor(t)} breach on ${providerLabel(a.provider)} account ${a.login} — account locked from trading.`,
        detectedAt: isoDaysAgo(0),
        status: 'active',
      });
    }
    // High/critical violation alerts.
    for (const type of vtypes) {
      const sev = severityFromDeduction(a.deductionBreakdown[type]);
      if (sev === 'critical' || sev === 'high') {
        alerts.push({
          id: `ALERT-${a.accountId}-${type}`,
          accountId: a.accountId,
          login: a.login,
          provider: a.provider,
          providerLabel: providerLabel(a.provider),
          assetClass,
          type,
          label: labelFor(type),
          severity: sev,
          message: `${labelFor(type)} on ${providerLabel(a.provider)} account ${a.login} — $${a.deductionBreakdown[type].toFixed(0)} at risk.`,
          detectedAt: isoDaysAgo(i % 3),
          status: i % 5 === 0 ? 'acknowledged' : 'active',
        });
      }
    }
  });
  // Most severe + most recent first.
  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;
  alerts.sort((x, y) => rank[x.severity] - rank[y.severity] || (x.detectedAt < y.detectedAt ? 1 : -1));
  return { data: alerts, total: alerts.length, active: alerts.filter((a) => a.status === 'active').length };
}

// ---------------------------------------------------------------------------
// Firm-wide cross-asset exposure  (GET /api/exposure) — always BOTH classes
// ---------------------------------------------------------------------------

function exposureFor(accts: MockAccount[]) {
  const inBreach = accts.filter((a) => a.canTrade === false || severityOf(a) === 'critical');
  return {
    accounts: accts.length,
    openExposure: accts.reduce((s, a) => s + a.balance, 0),
    payoutsPending: accts.reduce((s, a) => s + a.payoutAmount, 0),
    accountsInBreach: inBreach.length,
    totalDeductions: accts.reduce((s, a) => s + totalDeductions(a), 0),
  };
}

export function buildExposure() {
  const forex = exposureFor(FOREX_ACCOUNTS);
  const futures = exposureFor(FUTURES_ACCOUNTS);
  return {
    byAssetClass: { forex, futures },
    combined: {
      accounts: forex.accounts + futures.accounts,
      openExposure: forex.openExposure + futures.openExposure,
      payoutsPending: forex.payoutsPending + futures.payoutsPending,
      accountsInBreach: forex.accountsInBreach + futures.accountsInBreach,
      totalDeductions: forex.totalDeductions + futures.totalDeductions,
    },
  };
}

export function buildAnalyzeResult(assetClass: AssetClass, accountId: string) {
  // Search BOTH datasets by id (the analyze POST may not carry ?assetClass), so
  // the result always matches the clicked account regardless of asset class.
  const all = [...FOREX_ACCOUNTS, ...FUTURES_ACCOUNTS];
  const a = all.find((x) => x.accountId === accountId || x.login === accountId) || accountsFor(assetClass)[0];
  const vtypes = violationTypes(a);
  const td = totalDeductions(a);
  const futures = PROVIDER_META[a.provider]?.assetClass === 'futures';
  const symbols = futures ? ['ES', 'NQ', 'CL', 'GC'] : ['EURUSD', 'XAUUSD', 'GBPJPY', 'US30'];

  // A few synthetic closed trades so the expanded analysis table renders.
  const trades = Array.from({ length: 6 }, (_, i) => {
    const sym = symbols[i % symbols.length];
    const profit = Math.round((i % 2 === 0 ? 1 : -1) * (120 + i * 37));
    return {
      _id: `T-${a.accountId}-${i}`,
      position: `${a.accountId}${i}`,
      trdSymbol: sym,
      side: i % 2 === 0 ? 'Buy' : 'Sell',
      lots: futures ? 1 + (i % 3) : Number((0.2 + i * 0.1).toFixed(1)),
      openTime: isoDaysAgo(8 - i),
      closeTime: isoDaysAgo(8 - i),
      openPrice: 100 + i,
      closePrice: 100 + i + (profit > 0 ? 1 : -1),
      profit,
      commission: -2,
      swap: 0,
      duration: 0.05 + i * 0.1,
    };
  });

  // violation_details keyed by violation type (flat PayoutAnalysisResult shape).
  const violation_details: Record<string, { trade_id: string; explanation: string; amount: number }[]> = {};
  vtypes.forEach((t, i) => {
    violation_details[t] = [
      { trade_id: `T-${a.accountId}-${i}`, explanation: `${labelFor(t)} pattern detected on ${trades[i % trades.length].trdSymbol}`, amount: a.deductionBreakdown[t] },
    ];
  });

  return {
    data: {
      violation_details,
      deduction_breakdown: a.deductionBreakdown,
      trades,
      news_events: [],
      total_deductions: td,
      violation_count: vtypes.length,
      flagged_trade_count: vtypes.length,
      trades_fetched: true,
    },
  };
}
