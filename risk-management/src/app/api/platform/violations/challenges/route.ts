export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { getCachedAccounts } from '@/lib/challenges/cache';
import { cachedFetch } from '@/lib/cache/provider-cache';

const VIOLATION_TYPE_LABELS: Record<string, string> = {
  overleveraging: 'Overleveraging',
  hft: 'HFT',
  martingale: 'Martingale',
  news: 'News Trading',
  grid: 'Grid Trading',
  copy: 'Copy Trading',
  violations: 'Violations (General)',
  overnight: 'Overnight',
};

const CANONICAL_TYPE: Record<string, string> = {};

export async function GET(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') {
    const sp = request.nextUrl.searchParams;
    const { buildChallengeViolations } = await import('@/lib/mock/builders');
    return Response.json(buildChallengeViolations(Number(sp.get('page')) || 1, Number(sp.get('per_page')) || 100, sp.get('search') || '', sp.get('violation_type') || ''));
  }
  const params = Object.fromEntries(request.nextUrl.searchParams);
  const page = Math.max(1, parseInt(params.page || '1'));
  const perPage = Math.min(500, Math.max(1, parseInt(params.per_page || '100')));
  const search = params.search?.toLowerCase() || '';
  const violationTypeFilter = params.violation_type || '';

  try {
    const allAccounts = await cachedFetch(
      'provider:violations:challenges',
      60,
      () => getCachedAccounts({ withViolationsOnly: true })
    );
    console.log('[violations/challenges] accounts:', allAccounts.length,
      'sample breakdown:', allAccounts[0]?.deduction_breakdown,
      'sample total_deductions:', allAccounts[0]?.total_deductions);

    interface ViolationRecord {
      id: string;
      login: string;
      accountId: string;
      email: string;
      firstName: string;
      lastName: string;
      country: string;
      plan: string;
      phase: number;
      phaseLabel: string;
      startingBalance: number;
      balance: number;
      violationType: string;
      violationLabel: string;
      severity: string;
      flaggedTradeCount: number;
      totalDeduction: number;
      detectedAt: string;
      explanation: string;
      tradeDetails: { trade_id: string; explanation: string; amount: number }[];
      banNewsTrading: boolean;
      banHFT: boolean;
      banMTGL: boolean;
      tradedDays: number;
      hasNewsAddon: boolean;
    }

    const allViolations: ViolationRecord[] = [];
    for (const acct of allAccounts) {
      const details = acct.violation_details || {};
      for (const [violationType, amount] of Object.entries(acct.deduction_breakdown || {})) {
        if (amount <= 0) continue;
        if (violationType === 'profit_cap' || violationType === '2_percent_cap') continue;

        const severity = amount > 500 ? 'critical' : amount > 200 ? 'high' : amount > 50 ? 'medium' : 'low';
        const violationLabel = VIOLATION_TYPE_LABELS[violationType] || violationType;

        allViolations.push({
          id: `${acct.account_id}-${violationType}`,
          login: acct.login,
          accountId: acct.account_id,
          email: acct.email,
          firstName: acct.first_name,
          lastName: acct.last_name,
          country: acct.country,
          plan: acct.plan,
          phase: acct.phase,
          phaseLabel: acct.phase_label,
          startingBalance: acct.starting_balance,
          balance: acct.balance,
          violationType,
          violationLabel,
          severity,
          flaggedTradeCount: acct.flagged_trade_count,
          totalDeduction: amount,
          detectedAt: acct.processed_at,
          explanation: `${violationLabel} violation on challenge account ${acct.login} (${acct.plan}, ${acct.phase_label}). Deduction: $${amount.toFixed(2)}.`,
          tradeDetails: details[violationType] || [],
          banNewsTrading: acct.ban_news_trading,
          banHFT: acct.ban_hft,
          banMTGL: acct.ban_mtgl,
          tradedDays: acct.traded_days,
          hasNewsAddon: acct.has_news_addon,
        });
      }
    }

    console.log('[violations/challenges] total violations built:', allViolations.length);

    // Apply filters
    let filtered = allViolations;
    if (search) {
      filtered = filtered.filter(
        (v) =>
          v.login.toLowerCase().includes(search) ||
          v.accountId.toLowerCase().includes(search) ||
          v.email.toLowerCase().includes(search) ||
          v.firstName.toLowerCase().includes(search) ||
          v.lastName.toLowerCase().includes(search)
      );
    }
    if (violationTypeFilter) {
      const canonicalFilter = CANONICAL_TYPE[violationTypeFilter] || violationTypeFilter;
      filtered = filtered.filter((v) => v.violationType === canonicalFilter);
    }

    const total = filtered.length;
    const start = (page - 1) * perPage;
    const paginated = filtered.slice(start, start + perPage);

    return Response.json({
      data: paginated,
      total,
      page,
      per_page: perPage,
      total_pages: Math.ceil(total / perPage),
    });
  } catch (err) {
    return Response.json({ error: 'Failed to fetch challenge violations' }, { status: 500 });
  }
}
