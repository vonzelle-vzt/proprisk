import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { preTradeEvaluateBodySchema, validationErrorResponse } from '@/lib/api/schemas';
import { evaluatePreTrade } from '@/lib/risk/pretrade';
import type { RiskRule } from '@/types/risk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = preTradeEvaluateBodySchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  const supabase = await createClient();
  const { data: profile, error: profileError } = await supabase
    .from('risk_profiles')
    .select('id, rules_json')
    .eq('account_id', parsed.data.account_id)
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (profileError) return NextResponse.json({ error: profileError.message }, { status: 500 });
  if (!profile) {
    return NextResponse.json({ error: 'No active risk profile found for account.' }, { status: 404 });
  }

  const rules = (profile.rules_json as RiskRule[]) || [];
  const decision = evaluatePreTrade(parsed.data, rules);

  const { data: storedDecision, error: saveError } = await supabase
    .from('risk_pretrade_decisions')
    .insert({
      tenant_id: auth.tenantId,
      account_id: parsed.data.account_id,
      profile_id: profile.id,
      result: decision.result,
      risk_amount: decision.risk_amount,
      risk_percent: decision.risk_percent,
      violations_json: decision.violations,
      suggestions_json: decision.suggestions,
      request_json: parsed.data,
    })
    .select('id')
    .single();

  if (saveError) return NextResponse.json({ error: saveError.message }, { status: 500 });

  return NextResponse.json({
    data: {
      ...decision,
      decision_id: storedDecision.id,
    },
  });
}
