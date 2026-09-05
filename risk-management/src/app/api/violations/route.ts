import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { validationErrorResponse, violationsListQuerySchema } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const supabase = await createClient();
  const { searchParams } = new URL(request.url);
  const parsed = violationsListQuerySchema.safeParse(Object.fromEntries(searchParams.entries()));
  if (!parsed.success) return validationErrorResponse(parsed.error);
  const {
    page,
    per_page: perPage,
    start_date: startDate,
    end_date: endDate,
    violation_type: violationType,
    status,
    account_login: accountLogin,
  } = parsed.data;

  let query = supabase.from('violations').select(`
    *,
    accounts!inner(login, trader_name, email, account_size, challenge_type, phase)
  `, { count: 'exact' });

  if (startDate) query = query.gte('detected_at', `${startDate}T00:00:00Z`);
  if (endDate) query = query.lte('detected_at', `${endDate}T23:59:59Z`);
  if (violationType) query = query.eq('violation_type', violationType);
  if (status) query = query.eq('status', status);
  if (accountLogin) query = query.ilike('accounts.login', `%${accountLogin}%`);

  const from = (page - 1) * perPage;
  query = query.range(from, from + perPage - 1).order('detected_at', { ascending: false });

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
