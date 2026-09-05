import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { createRiskProfileBodySchema, validationErrorResponse } from '@/lib/api/schemas';
import { normalizeAndValidateProfile } from '@/lib/risk/rules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get('account_id');
  if (!accountId) {
    return NextResponse.json({ error: 'account_id is required' }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('risk_profiles')
    .select('*')
    .eq('account_id', accountId)
    .order('updated_at', { ascending: false });

  if (error) return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

export async function POST(request: NextRequest) {
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = createRiskProfileBodySchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  const normalized = normalizeAndValidateProfile(parsed.data);
  if (!normalized.validation.valid) {
    return NextResponse.json(
      { error: 'Risk profile validation failed', details: normalized.validation.errors },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('risk_profiles')
    .insert({
      tenant_id: auth.tenantId,
      account_id: normalized.profile.account_id,
      name: normalized.profile.name,
      status: normalized.profile.status,
      version: 1,
      rules_json: normalized.profile.rules,
    })
    .select('*')
    .single();

  if (error) return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
