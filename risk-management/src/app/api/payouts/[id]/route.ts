export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { updatePayoutBodySchema, validationErrorResponse } from '@/lib/api/schemas';
import { logError } from '@/lib/logging/logger';
import { DEMO_MODE } from '@/lib/demo';
import { requireRiskUser, requireRiskManager } from '@/lib/auth/guards';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (DEMO_MODE) return Response.json({ data: { id, status: 'Pending', notes: '' } });

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const sb = await createClient();

  // Try payout_history first (by UUID), then by platform_payout_id
  let { data, error } = await sb.from('payout_history').select('*').eq('id', id).maybeSingle();

  if (!data && !error) {
    ({ data, error } = await sb.from('payout_history').select('*').eq('platform_payout_id', id).order('decided_at', { ascending: false }).limit(1).maybeSingle());
  }

  if (error) {
    logError('Failed to fetch payout record', error, { route: '/api/payouts/[id]', category: 'database' });
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
  if (!data) return Response.json({ error: 'Record not found' }, { status: 404 });

  return Response.json({ data });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();
  const parsed = updatePayoutBodySchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  if (DEMO_MODE) return Response.json({ data: { id, ...parsed.data } });

  // PATCH edits the notes on an already-decided payout — that record is part of
  // the dispute evidence trail, so it is manager-grade, not analyst-grade.
  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

  const sb = await createClient();

  const { data: existing, error: fetchErr } = await sb
    .from('payout_history')
    .select('*')
    .eq('id', id)
    .single();
  if (fetchErr || !existing) return Response.json({ error: 'Record not found' }, { status: 404 });

  const updates: Record<string, unknown> = {};
  if (parsed.data.notes !== undefined) updates.decision_notes = parsed.data.notes;

  const { data, error } = await sb
    .from('payout_history')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    logError('Failed to update payout record', error, { route: '/api/payouts/[id]', category: 'database' });
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }

  return Response.json({ data });
}
