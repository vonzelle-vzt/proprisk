import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskManager } from '@/lib/auth/guards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  // Activating a profile changes which rules the live engine enforces.
  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

  const profileId = params.id;
  const supabase = await createClient();

  const { data: targetProfile, error: targetError } = await supabase
    .from('risk_profiles')
    .select('id, account_id')
    .eq('id', profileId)
    .single();

  if (targetError || !targetProfile) {
    return NextResponse.json({ error: 'Risk profile not found' }, { status: 404 });
  }

  const { error: resetError } = await supabase
    .from('risk_profiles')
    .update({ status: 'archived' })
    .eq('account_id', targetProfile.account_id)
    .eq('status', 'active');

  if (resetError) return NextResponse.json({ error: resetError.message }, { status: 500 });

  const { data, error } = await supabase
    .from('risk_profiles')
    .update({ status: 'active' })
    .eq('id', profileId)
    .select('*')
    .single();

  if (error) return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  return NextResponse.json({ data });
}
