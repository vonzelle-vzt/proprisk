export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { historyListQuerySchema, validationErrorResponse } from '@/lib/api/schemas';
import type { PayoutHistoryRecord } from '@/types/history';
import { DEMO_MODE, demoQuery } from '@/lib/demo';
import { buildHistory } from '@/lib/mock/builders';

function mapRow(row: any): PayoutHistoryRecord {
  return {
    id: row.id,
    platformPayoutId: row.platform_payout_id,
    platformAccountId: row.platform_account_id,
    platformOrderId: row.platform_order_id,
    login: row.login,
    customerId: row.customer_id,
    userId: row.user_id,
    decision: row.decision,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNotes: row.decision_notes,
    amount: row.amount ? Number(row.amount) : undefined,
    clientAmount: row.client_amount ? Number(row.client_amount) : undefined,
    fee: row.fee ? Number(row.fee) : undefined,
    profitSharePct: row.profit_share_pct ? Number(row.profit_share_pct) : undefined,
    method: row.method,
    plan: row.plan,
    dateRequested: row.date_requested,
    balance: row.balance ? Number(row.balance) : undefined,
    totalPnl: row.total_pnl ? Number(row.total_pnl) : undefined,
    startingBalance: row.starting_balance ? Number(row.starting_balance) : undefined,
    tradedDays: row.traded_days,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    country: row.country,
    kycStatus: row.kyc_status,
    kycVerified: row.kyc_verified,
    isBlacklisted: row.is_blacklisted,
    preApprovedStatus: row.pre_approved_status,
    preApprovedBy: row.pre_approved_by,
    violationsList: row.violations_list || [],
    deductionsTotal: Number(row.deductions_total || 0),
    deductionsViolationCount: row.deductions_violation_count || 0,
    deductionsByType: row.deductions_by_type || {},
    fullSnapshot: row.full_snapshot || {},
    createdAt: row.created_at,
  };
}

function applyFilters(
  query: any,
  filters: { decision?: string; start_date?: string; end_date?: string; search?: string }
) {
  if (filters.decision) query = query.eq('decision', filters.decision);
  if (filters.start_date) query = query.gte('decided_at', filters.start_date);
  if (filters.end_date) query = query.lte('decided_at', filters.end_date + 'T23:59:59.999Z');
  if (filters.search) {
    query = query.or(
      `login.ilike.%${filters.search}%,email.ilike.%${filters.search}%,first_name.ilike.%${filters.search}%,last_name.ilike.%${filters.search}%`
    );
  }
  return query;
}

export async function GET(request: NextRequest) {
  if (DEMO_MODE) {
    const q = demoQuery(request);
    return Response.json(buildHistory(q.assetClass, q.page, q.perPage, q.search));
  }
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = historyListQuerySchema.safeParse(params);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  const { page, per_page, start_date, end_date, decision, search } = parsed.data;
  const filters = { decision, start_date, end_date, search };
  const sb = await createClient();

  const offset = (page - 1) * per_page;

  // Single query with exact count — Supabase returns count alongside paginated data
  let dataQuery = sb.from('payout_history').select('*', { count: 'exact' });
  dataQuery = applyFilters(dataQuery, filters);
  dataQuery = dataQuery.order('decided_at', { ascending: false }).range(offset, offset + per_page - 1);
  const { data, count, error } = await dataQuery;

  const total = count ?? 0;

  if (error) {
    return Response.json({ error: 'Failed to fetch history' }, { status: 500 });
  }

  return Response.json({
    data: (data || []).map(mapRow),
    meta: { page, per_page, total, total_pages: Math.ceil(total / per_page) },
  }, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
