import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { accountListQuerySchema, validationErrorResponse } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const supabase = await createClient();
  const { searchParams } = new URL(request.url);
  const parsed = accountListQuerySchema.safeParse(Object.fromEntries(searchParams.entries()));
  if (!parsed.success) return validationErrorResponse(parsed.error);
  const { page, per_page: perPage, search, phase, challenge_type: challengeType, account_size: accountSize } = parsed.data;

  let query = supabase.from('accounts').select('*', { count: 'exact' });

  if (search) query = query.ilike('login', `%${search}%`);
  if (phase) query = query.eq('phase', phase);
  if (challengeType) query = query.eq('challenge_type', challengeType);
  if (accountSize) query = query.eq('account_size', accountSize);

  const from = (page - 1) * perPage;
  query = query.range(from, from + perPage - 1).order('created_at', { ascending: false });

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
