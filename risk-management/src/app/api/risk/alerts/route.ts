import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { riskAlertListQuerySchema, validationErrorResponse } from '@/lib/api/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const parsed = riskAlertListQuerySchema.safeParse(Object.fromEntries(searchParams.entries()));
  if (!parsed.success) return validationErrorResponse(parsed.error);

  const { page, per_page: perPage, account_id: accountId, status, severity } = parsed.data;
  const from = (page - 1) * perPage;

  const supabase = await createClient();
  let query = supabase.from('risk_alerts').select('*', { count: 'exact' });

  if (accountId) query = query.eq('account_id', accountId);
  if (status) query = query.eq('status', status);
  if (severity) query = query.eq('severity', severity);

  query = query
    .order('severity', { ascending: false })
    .order('created_at', { ascending: false })
    .range(from, from + perPage - 1);

  const { data, count, error } = await query;
  if (error) return NextResponse.json({ error: 'Internal server error' }, { status: 500 });

  return NextResponse.json({
    data: data || [],
    total: count || 0,
    page,
    per_page: perPage,
    total_pages: Math.ceil((count || 0) / perPage),
  });
}
