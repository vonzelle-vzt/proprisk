export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { fetchPendingPayouts } from '@/lib/platform/client';
import { payoutsListQuerySchema, validationErrorResponse } from '@/lib/api/schemas';
import { enrichPayouts } from '@/lib/payouts/enrich';
import { buildRecordFromPayout } from '@/lib/payouts/map-payout';
import type { PlatformPayout } from '@/types/platform';
import { logError, logInfo } from '@/lib/logging/logger';
import { savePayoutSnapshot } from '@/lib/payouts/snapshot';
import { DEMO_MODE, demoQuery } from '@/lib/demo';
import { buildPayouts } from '@/lib/mock/builders';
import { cachedFetch } from '@/lib/cache/provider-cache';
import { requireRiskUser } from '@/lib/auth/guards';

export async function GET(request: NextRequest) {
  if (DEMO_MODE) {
    const q = demoQuery(request);
    return Response.json(buildPayouts(q.assetClass, q.page, q.perPage, q.search));
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = payoutsListQuerySchema.safeParse(params);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  const { page, per_page, status, search, start_date, end_date } = parsed.data;

  try {
    // Fetch ALL pending payouts from the provider platform. Filtering/pagination
    // happens after, so only the raw fetch is cached (45s) — every request in
    // that window shares one upstream call regardless of page/search/filters.
    // Keyed per-tenant: an unscoped key would let one tenant's cached fetch
    // answer another tenant's request within the cache window.
    const payouts = await cachedFetch(`provider:payouts:pending:1000:${auth.tenantId}`, 45, () =>
      fetchPendingPayouts({
        statuses: ['Pending'],
        limit: 1000,
      }, auth.tenantId)
    );

    // Deduplicate by _id (the platform provides _id for payouts)
    const payoutMap = new Map<string, PlatformPayout>();
    for (const p of payouts) {
      const id = p._id || `${p.accountId}-${p.orderId}`;
      if (!payoutMap.has(id)) payoutMap.set(id, p);
    }

    // Build records (status=Pending already requested from the provider platform)
    let records = Array.from(payoutMap.values()).map(buildRecordFromPayout);

    // Apply date filter
    if (start_date || end_date) {
      records = records.filter((r) => {
        if (!r.dateRequested) return true;
        const d = new Date(r.dateRequested);
        if (start_date && d < new Date(start_date)) return false;
        if (end_date) {
          const ed = new Date(end_date);
          ed.setHours(23, 59, 59, 999);
          if (d > ed) return false;
        }
        return true;
      });
    }

    // Apply status filter
    if (status) records = records.filter((r) => r.status === status);

    // Apply search filter
    if (search) {
      const q = search.toLowerCase();
      records = records.filter(
        (r) =>
          r.orderNumber?.toLowerCase().includes(q) ||
          r.accountId?.toLowerCase().includes(q) ||
          r.email?.toLowerCase().includes(q) ||
          r.login?.toLowerCase().includes(q)
      );
    }

    // Paginate
    const total = records.length;
    const start = (page - 1) * per_page;
    const paginated = records.slice(start, start + per_page);

    // Enrich the current page with account details, user details, and risk data
    const enriched = await enrichPayouts(paginated, auth.tenantId);

    // Auto-snapshot enriched pending payouts to Supabase (fire-and-forget)
    // This ensures pending payout data is never lost even if the platform purges them
    Promise.allSettled(
      enriched.map((record) =>
        savePayoutSnapshot(record, 'pending', 'system:auto-snapshot')
      )
    ).then((results) => {
      const saved = results.filter((r) => r.status === 'fulfilled' && r.value !== null).length;
      if (saved > 0) {
        logInfo(`Auto-snapshot: saved ${saved} pending payouts`, { route: '/api/payouts', category: 'database' });
      }
    }).catch(() => { /* non-critical */ });

    return Response.json({
      data: enriched,
      meta: { page, per_page, total, total_pages: Math.ceil(total / per_page) },
    }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (err) {
    logError('Failed to fetch payouts', err, { route: '/api/payouts', category: 'external_api' });
    return Response.json({ error: 'Failed to fetch payouts' }, { status: 500 });
  }
}
