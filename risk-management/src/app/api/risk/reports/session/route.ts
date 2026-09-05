import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { sessionReportQuerySchema, validationErrorResponse } from '@/lib/api/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const parsed = sessionReportQuerySchema.safeParse(Object.fromEntries(searchParams.entries()));
  if (!parsed.success) return validationErrorResponse(parsed.error);

  const supabase = await createClient();
  const { account_id: accountId, session_date: sessionDate } = parsed.data;

  const { data, error } = await supabase
    .from('risk_session_reports')
    .select('*')
    .eq('account_id', accountId)
    .eq('session_date', sessionDate)
    .limit(1)
    .maybeSingle();

  if (error) return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Session report not found' }, { status: 404 });

  return NextResponse.json({ data });
}
