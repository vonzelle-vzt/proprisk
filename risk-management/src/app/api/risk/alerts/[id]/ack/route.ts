import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { violationIdParamSchema, validationErrorResponse } from '@/lib/api/schemas';
import { requireRiskUser } from '@/lib/auth/guards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const parsed = violationIdParamSchema.safeParse(params);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('risk_alerts')
    .update({ status: 'acknowledged', acknowledged_at: new Date().toISOString() })
    .eq('id', parsed.data.id)
    .neq('status', 'resolved')
    .select('*')
    .single();

  if (error) return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  return NextResponse.json({ data });
}
