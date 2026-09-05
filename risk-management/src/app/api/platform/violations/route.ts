export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import {
  fetchPendingPayouts,
  fetchAccountDetails,
  fetchUserDetails,
} from '@/lib/platform/client';
import { runLocalViolationAnalysis } from '@/lib/payouts/local-analysis';
import type { PlatformPayout } from '@/types/platform';
import { logError } from '@/lib/logging/logger';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { DEMO_MODE, demoQuery } from '@/lib/demo';
import { buildViolations } from '@/lib/mock/builders';
import { cachedFetch } from '@/lib/cache/provider-cache';
import { requireRiskUser } from '@/lib/auth/guards';

const CONCURRENCY = 5;

// Map provider violation type keys to labels
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

interface PlatformViolationRecord {
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
  balance: number;
  totalPnL: number;
  violationType: string;
  violationLabel: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  flaggedTradeCount: number;
  totalDeduction: number;
  detectedAt: string;
  explanation: string;
  banNewsTrading: boolean;
  banHFT: boolean;
  banMTGL: boolean;
  tradedDays: number;
}

export async function GET(request: NextRequest) {
  if (DEMO_MODE) {
    const q = demoQuery(request);
    return Response.json(buildViolations(q.assetClass, q.page, q.perPage || 100, q.search, q.violationType));
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  // Live path only (demo serves static mocks above): fan-out route, throttle.
  const rl = await checkRateLimit('platform-violations', { windowMs: 60_000, maxRequests: 10 });
  if (!rl.allowed) return rateLimitResponse(rl);
  const params = Object.fromEntries(request.nextUrl.searchParams);
  const page = Math.max(1, parseInt(params.page || '1'));
  const perPage = Math.min(500, Math.max(1, parseInt(params.per_page || '100')));
  const search = params.search?.toLowerCase() || '';
  const violationTypeFilter = params.violation_type || '';

  try {
    // Fetch ALL pending payouts + fan out per-account detail/violation scans.
    // Filtering/search/pagination happens after, so the whole fan-out is
    // cached as one unit (60s) — every request in that window shares one
    // round of upstream calls regardless of page/search/filters.
    const allViolations = await cachedFetch(`provider:violations:pending:${auth.tenantId}`, 60, async () => {
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
      const violations: PlatformViolationRecord[] = [];
      const now = new Date().toISOString();

      // Process accounts with bounded concurrency
      for (let i = 0; i < accounts.length; i += CONCURRENCY) {
        const batch = accounts.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async (payout) => {
            const accountId = payout.accountId.toString();
            const [accountDetails, userDetails] = await Promise.all([
              fetchAccountDetails(accountId, auth.tenantId),
              payout.userId ? fetchUserDetails(payout.userId, auth.tenantId) : Promise.resolve(null),
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

            return { payout, accountDetails, userDetails, localResult };
          })
        );

        for (const r of results) {
          if (r.status !== 'fulfilled') continue;
          const { payout, accountDetails, userDetails, localResult } = r.value;

          const mergedBreakdown = localResult.mergedBreakdown;
          if (Object.keys(mergedBreakdown).length === 0) continue;

          const accountId = payout.accountId.toString();
          const na = (v: unknown) => (v == null || v === 'N/A' || v === 'n/a' || v === 'NA' || v === '') ? '' : String(v);
          const login = na(payout.login) || na(accountDetails?.login) || '';
          const email = na(payout.email) || na(userDetails?.email) || '';
          const firstName = na(userDetails?.firstName);
          const lastName = na(userDetails?.lastName);
          const country = na(userDetails?.country);
          const rawKyc = na(userDetails?.kycStatus);
          const kycStatus = rawKyc === 'COMPLETED' ? 'Verified' : rawKyc || 'Unknown';
          const plan = na(accountDetails?.planName) || na(payout.plan) || '';
          const startingBalance = accountDetails?.startingBalance || 0;
          const balance = payout.balance || accountDetails?.lastBalance || 0;
          const totalPnL = payout.totalPnL || 0;
          const flaggedTradeCount = localResult.localAnalysis.summary.violatingTradeCount;

          // Create a violation record per type
          for (const [violationType, amount] of Object.entries(mergedBreakdown)) {
            const severity = amount > 500 ? 'critical' : amount > 200 ? 'high' : amount > 50 ? 'medium' : 'low';

            violations.push({
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
              balance,
              totalPnL,
              violationType,
              violationLabel: VIOLATION_TYPE_LABELS[violationType] || violationType,
              severity,
              flaggedTradeCount,
              totalDeduction: amount,
              detectedAt: now,
              explanation: violationType === 'news'
                ? `News Trading violation on account ${login} (${plan}). Deduction: $${amount.toFixed(2)}. Confirmed against FXStreet & Forex Factory economic calendars.`
                : `${VIOLATION_TYPE_LABELS[violationType] || violationType} violation on account ${login} (${plan}). Deduction: $${amount.toFixed(2)} of $${startingBalance.toLocaleString()} starting balance. KYC: ${kycStatus}, Country: ${country}`,
              banNewsTrading: accountDetails?.banNewsTrading === 1,
              banHFT: accountDetails?.banHFT === 1,
              banMTGL: accountDetails?.banMTGL === 1,
              tradedDays: accountDetails?.tradedDays || 0,
            });
          }
        }
      }

      return violations;
    });

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

    // Paginate
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
    logError('Failed to fetch violations', err, { route: '/api/platform/violations', category: 'external_api' });
    return Response.json({ error: 'Failed to fetch violations' }, { status: 500 });
  }
}
