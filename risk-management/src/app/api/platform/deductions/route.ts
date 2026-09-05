export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import {
  fetchPendingPayouts,
  fetchAccountDetails,
  fetchUserDetails,
  fetchLedgerEvents,
} from '@/lib/platform/client';
import { runLocalViolationAnalysis } from '@/lib/payouts/local-analysis';
import type { PlatformPayout } from '@/types/platform';
import { logError } from '@/lib/logging/logger';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { DEMO_MODE, demoQuery } from '@/lib/demo';
import { buildDeductions } from '@/lib/mock/builders';
import { cachedFetch } from '@/lib/cache/provider-cache';
import { requireRiskUser } from '@/lib/auth/guards';

const CONCURRENCY = 5;

interface PlatformDeductionRecord {
  id: string;
  login: string;
  accountId: string;
  email: string;
  firstName: string;
  lastName: string;
  country: string;
  kycStatus: string;
  plan: string;
  startingBalance: number;
  violationType: string;
  violationLabel: string;
  deductionAmount: number;
  deductionDate: string;
  deductionNote: string;
  explanation: string;
  detectedAt: string;
}

const VIOLATION_TYPE_LABELS: Record<string, string> = {
  overleveraging: 'Overleveraging',
  hft: 'HFT',
  martingale: 'Martingale',
  news: 'News Trading',
  grid: 'Grid Trading',
  copy: 'Copy Trading',
  violations: 'Violations',
  overnight: 'Overnight',
};

const CANONICAL_TYPE: Record<string, string> = {};

export async function GET(request: NextRequest) {
  if (DEMO_MODE) {
    const q = demoQuery(request);
    return Response.json(buildDeductions(q.assetClass, q.page, q.perPage || 100, q.search, q.violationType));
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  // Live path only (demo serves static mocks above): fan-out route, throttle.
  const rl = await checkRateLimit('platform-deductions', { windowMs: 60_000, maxRequests: 10 });
  if (!rl.allowed) return rateLimitResponse(rl);
  const params = Object.fromEntries(request.nextUrl.searchParams);
  const page = Math.max(1, parseInt(params.page || '1'));
  const perPage = Math.min(500, Math.max(1, parseInt(params.per_page || '100')));
  const search = params.search?.toLowerCase() || '';
  const violationTypeFilter = params.violation_type || '';

  try {
    // Fetch ALL pending payouts + fan out per-account detail/ledger scans.
    // Filtering/search/pagination happens after, so the whole fan-out is
    // cached as one unit (60s) — every request in that window shares one
    // round of upstream calls regardless of page/search/filters.
    const allDeductions = await cachedFetch(`provider:deductions:pending:${auth.tenantId}`, 60, async () => {
      // Fetch ALL pending payouts — no date-field to ensure nothing is excluded
      const payouts = await fetchPendingPayouts({
        statuses: ['Pending'],
        limit: 1000,
      }, auth.tenantId);

      // Deduplicate by accountId
      const uniqueAccounts = new Map<string, PlatformPayout>();
      for (const p of payouts) {
        if (p.status?.toLowerCase() === 'pending' && p.accountId && !uniqueAccounts.has(p.accountId)) {
          uniqueAccounts.set(p.accountId, p);
        }
      }

      const accounts = Array.from(uniqueAccounts.values());
      const deductions: PlatformDeductionRecord[] = [];

      // Process accounts with bounded concurrency
      for (let i = 0; i < accounts.length; i += CONCURRENCY) {
        const batch = accounts.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async (payout) => {
            const accountId = payout.accountId.toString();
            const [accountDetails, userDetails, ledgerEvents] = await Promise.all([
              fetchAccountDetails(accountId, auth.tenantId),
              payout.userId ? fetchUserDetails(payout.userId, auth.tenantId) : Promise.resolve(null),
              fetchLedgerEvents(accountId, { limit: 100 }, auth.tenantId),
            ]);

            const email = payout.email || userDetails?.email || '';

            // Run local violation analysis — same logic as challenges, all types
            const localResult = await runLocalViolationAnalysis({
              accountId,
              email,
              startingBalance: accountDetails?.startingBalance || 0,
              priorDayBalance: accountDetails?.priorDayBalance,
              priorDayEquity: accountDetails?.priorDayEquity,
              planName: accountDetails?.planName || payout.plan || '',
              tenantId: auth.tenantId,
            });

            return { payout, accountDetails, userDetails, ledgerEvents, localResult };
          })
        );

        for (const r of results) {
          if (r.status !== 'fulfilled') continue;
          const { payout, accountDetails, userDetails, ledgerEvents, localResult } = r.value;

          const mergedBreakdown = localResult.mergedBreakdown;
          if (Object.keys(mergedBreakdown).length === 0) continue;

          // Get actual deduction events from ledger
          const deductionEvents = ledgerEvents.filter(
            (e) => e.event === 'cash_oper' && (e.data?.note?.includes('Deduction') || (e.data?.amount && e.data.amount < 0))
          );

          const na = (v: unknown) => (v == null || v === 'N/A' || v === 'n/a' || v === 'NA' || v === '') ? '' : String(v);
          const accountId = payout.accountId.toString();
          const login = na(payout.login) || na(accountDetails?.login) || '';
          const email = na(payout.email) || na(userDetails?.email) || '';
          const firstName = na(userDetails?.firstName);
          const lastName = na(userDetails?.lastName);
          const country = na(userDetails?.country);
          const rawKyc = na(userDetails?.kycStatus);
          const kycStatus = rawKyc === 'COMPLETED' ? 'Verified' : rawKyc || 'Unknown';
          const plan = na(accountDetails?.planName) || na(payout.plan) || '';
          const startingBalance = accountDetails?.startingBalance || 0;

          // Create a deduction record per type
          for (const [violationType, amount] of Object.entries(mergedBreakdown)) {
            // Find matching ledger event for this deduction
            const matchingEvent = deductionEvents.find((e) => {
              const note = (e.data?.note || '').toLowerCase();
              return note.includes(violationType.toLowerCase()) ||
                     note.includes('deduction') ||
                     note.includes('risk');
            });

            const violationLabel = VIOLATION_TYPE_LABELS[violationType] || violationType;
            const deductionDate = matchingEvent?.time || new Date().toISOString();
            const ledgerNote = matchingEvent?.data?.note || '';

            // Build a meaningful note — never show N/A
            let deductionNote: string;
            if (ledgerNote && !ledgerNote.includes('N/A') && ledgerNote.length > 5) {
              deductionNote = ledgerNote;
            } else {
              deductionNote = `${violationLabel} — $${amount.toFixed(2)} deducted from ${plan || 'account'} (${login})`;
            }

            const explanation = violationType === 'news'
              ? `News Trading violation: $${amount.toFixed(2)} deducted. Account ${login}, plan: ${plan}. Confirmed against FXStreet & Forex Factory economic calendars.`
              : `${violationLabel} violation: $${amount.toFixed(2)} deducted. Account ${login}, starting balance $${startingBalance.toLocaleString()}, plan: ${plan}. KYC: ${kycStatus}, Country: ${country}.`;

            deductions.push({
              id: `${accountId}-${violationType}`,
              login,
              accountId,
              email,
              firstName,
              lastName,
              country,
              kycStatus,
              plan,
              startingBalance,
              violationType,
              violationLabel,
              deductionAmount: amount,
              deductionDate,
              deductionNote,
              explanation,
              detectedAt: deductionDate,
            });
          }
        }
      }

      return deductions;
    });

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
    logError('Failed to fetch deductions', err, { route: '/api/platform/deductions', category: 'external_api' });
    return Response.json({ error: 'Failed to fetch deductions' }, { status: 500 });
  }
}
