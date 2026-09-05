import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { emailsListQuerySchema, validationErrorResponse } from '@/lib/api/schemas';
import { DEMO_MODE, demoQuery } from '@/lib/demo';
import { buildEmails } from '@/lib/mock/builders';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (DEMO_MODE) {
    const q = demoQuery(request);
    return NextResponse.json(buildEmails(q.assetClass, q.page, q.perPage, q.search));
  }
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const supabase = await createClient();
  const { searchParams } = new URL(request.url);
  const parsed = emailsListQuerySchema.safeParse(Object.fromEntries(searchParams.entries()));
  if (!parsed.success) return validationErrorResponse(parsed.error);
  const { account_id: accountId, template_type: templateType, search, status, page, per_page: perPage } = parsed.data;

  let query = supabase.from('emails').select('*', { count: 'exact' });
  if (accountId) query = query.eq('account_id', accountId);
  if (templateType) query = query.eq('template_type', templateType);
  if (status) query = query.eq('status', status);
  if (search) {
    const safe = search.replace(/[^A-Za-z0-9 @._-]/g, '').replace(/[%_]/g, m => '\\' + m);
    if (safe) query = query.or(`recipient.ilike.%${safe}%,subject.ilike.%${safe}%,challenge_account_id.ilike.%${safe}%`);
  }

  const from = (page - 1) * perPage;
  query = query.range(from, from + perPage - 1).order('sent_at', { ascending: false });

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
