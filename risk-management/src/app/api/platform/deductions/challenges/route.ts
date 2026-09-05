export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { getCachedAccounts, type CachedChallengeAccount } from '@/lib/challenges/cache';
import { cachedFetch } from '@/lib/cache/provider-cache';

const CANONICAL_TYPE: Record<string, string> = {};

export async function GET(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') {
    const sp = request.nextUrl.searchParams;
    const { buildChallengeDeductions } = await import('@/lib/mock/builders');
    return Response.json(buildChallengeDeductions(Number(sp.get('page')) || 1, Number(sp.get('per_page')) || 100, sp.get('search') || '', sp.get('violation_type') || ''));
  }
  const params = Object.fromEntries(request.nextUrl.searchParams);
  const page = Math.max(1, parseInt(params.page || '1'));
  const perPage = Math.min(500, Math.max(1, parseInt(params.per_page || '100')));
  const search = params.search?.toLowerCase() || '';
  const violationTypeFilter = params.violation_type || '';

  try {
    const allAccounts = await cachedFetch(
      'provider:deductions:challenges',
      60,
      () => getCachedAccounts()
    );

    // Build deduction records from cached accounts
    interface DeductionRecord {
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
      violationType: string;
      violationLabel: string;
      deductionAmount: number;
      deductionDate: string;
      deductionNote: string;
      explanation: string;
      tradeDetails: { trade_id: string; explanation: string; amount: number }[];
      detectedAt: string;
    }

    const allDeductions: DeductionRecord[] = [];
    for (const acct of allAccounts) {
      const details = acct.violation_details || {};
      for (const [violationType, amount] of Object.entries(acct.deduction_breakdown || {})) {
        if (amount <= 0) continue;
        if (violationType === 'profit_cap' || violationType === '2_percent_cap') continue;

        const violationLabel = acct.violation_labels[acct.violation_types.indexOf(violationType)] || violationType;
        allDeductions.push({
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
          violationType,
          violationLabel,
          deductionAmount: amount,
          deductionDate: acct.processed_at,
          deductionNote: `${violationLabel} — $${amount.toFixed(2)} deducted from ${acct.plan || 'account'} (${acct.login})`,
          explanation: `${violationLabel} violation on challenge account ${acct.login} (${acct.plan}, ${acct.phase_label}). Deduction: $${amount.toFixed(2)}.`,
          tradeDetails: details[violationType] || [],
          detectedAt: acct.processed_at,
        });
      }
    }

    // Apply filters
    let filtered = allDeductions;
    if (search) {
      filtered = filtered.filter(
        (d) =>
          d.login.toLowerCase().includes(search) ||
          d.accountId.toLowerCase().includes(search) ||
          d.email.toLowerCase().includes(search) ||
          d.firstName.toLowerCase().includes(search) ||
          d.lastName.toLowerCase().includes(search)
      );
    }
    if (violationTypeFilter) {
      const canonicalFilter = CANONICAL_TYPE[violationTypeFilter] || violationTypeFilter;
      filtered = filtered.filter((d) => d.violationType === canonicalFilter);
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
    return Response.json({ error: 'Failed to fetch challenge deductions' }, { status: 500 });
  }
}
