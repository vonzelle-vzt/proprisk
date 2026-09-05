export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const sb = await createClient();

  const { data, error } = await sb
    .from('payout_history')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    return Response.json({ error: 'Record not found' }, { status: 404 });
  }

  return Response.json({ data });
}
