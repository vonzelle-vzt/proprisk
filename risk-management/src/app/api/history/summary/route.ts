export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { DEMO_MODE, assetClassFromRequest } from '@/lib/demo';
import { buildHistorySummary } from '@/lib/mock/builders';
import { cachedFetch } from '@/lib/cache/provider-cache';

interface HistorySummary {
  totalApproved: number;
  totalRejected: number;
  totalAmountPaid: number;
  avgPayout: number;
  totalDeductions: number;
}

export async function GET(request: NextRequest) {
  if (DEMO_MODE) return Response.json({ data: buildHistorySummary(assetClassFromRequest(request)) });
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const params = request.nextUrl.searchParams;
  const rawStart = params.get('start_date');
  const rawEnd = params.get('end_date');

  // Validate + bound the requested window before it becomes a cache key (and
  // drives a scan). Reject unparseable dates or spans wider than 400 days so a
  // caller can't key the cache with garbage or an unbounded range.
  if (rawStart && Number.isNaN(Date.parse(rawStart))) {
    return Response.json({ error: 'Invalid start_date' }, { status: 400 });
  }
  if (rawEnd && Number.isNaN(Date.parse(rawEnd))) {
    return Response.json({ error: 'Invalid end_date' }, { status: 400 });
  }

  const startDate = rawStart || null;
  const endDate = rawEnd ? rawEnd + 'T23:59:59.999Z' : null;

  if (startDate && endDate) {
    const spanDays = (Date.parse(endDate) - Date.parse(startDate)) / (24 * 60 * 60 * 1000);
    if (spanDays < 0) {
      return Response.json({ error: 'end_date must be on or after start_date' }, { status: 400 });
    }
    if (spanDays > 400) {
      return Response.json({ error: 'Date range too large (max 400 days)' }, { status: 400 });
    }
  }

  // The RPC (or its 50k-row fallback scan) is the expensive part — cache the
  // whole aggregation for 120s, keyed by tenant + the date range that changes
  // its result. Without the tenant in the key, the first firm to hit a given
  // range would have its aggregation served back to every other firm for 120s.
  const cacheKey = `provider:history:summary:${auth.tenantId}:${startDate || 'all'}:${endDate || 'all'}`;

  try {
    // Errors thrown from fn() propagate past cachedFetch without being
    // cached, so a transient DB failure never poisons the cache for 120s.
    const summary = await cachedFetch<HistorySummary>(cacheKey, 120, async () => {
      const sb = await createClient();

      // Use RPC for server-side aggregation (no row limit issue)
      const { data: rpcData, error: rpcError } = await sb.rpc('payout_history_summary', {
        p_start_date: startDate,
        p_end_date: endDate,
      });

      if (!rpcError && rpcData) {
        return rpcData as HistorySummary;
      }

      // Fallback: client-side aggregation with high limit
      let query = sb.from('payout_history').select('decision, client_amount, deductions_total').limit(50000);
      if (startDate) query = query.gte('decided_at', startDate);
      if (endDate) query = query.lte('decided_at', endDate);

      const { data, error } = await query;

      if (error) {
        throw error;
      }

      const rows = data || [];
      const approved = rows.filter((r) => r.decision === 'approved');
      const rejected = rows.filter((r) => r.decision === 'rejected');
      const totalAmountPaid = approved.reduce((s, r) => s + Number(r.client_amount || 0), 0);

      return {
        totalApproved: approved.length,
        totalRejected: rejected.length,
        totalAmountPaid,
        avgPayout: approved.length > 0 ? totalAmountPaid / approved.length : 0,
        totalDeductions: rows.reduce((s, r) => s + Number(r.deductions_total || 0), 0),
      };
    });

    return Response.json({ data: summary }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch {
    return Response.json({ error: 'Failed to fetch summary' }, { status: 500 });
  }
}
