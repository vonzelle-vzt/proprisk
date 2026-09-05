import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { riskEventBodySchema, validationErrorResponse } from '@/lib/api/schemas';
import { processRiskTradeEvent } from '@/lib/risk/worker';
import type { RiskTradeEvent } from '@/types/risk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = riskEventBodySchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  const supabase = await createClient();
  const payload = parsed.data;

  const { data: existing, error: existingError } = await supabase
    .from('risk_trade_events')
    .select('id')
    .eq('account_id', payload.account_id)
    .eq('idempotency_key', payload.idempotency_key)
    .limit(1);

  if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });
  if (existing && existing.length > 0) {
    return NextResponse.json({ data: { accepted: true, deduplicated: true } });
  }

  const { data, error } = await supabase
    .from('risk_trade_events')
    .insert({
      tenant_id: auth.tenantId,
      account_id: payload.account_id,
      event_type: payload.event_type,
      symbol: payload.symbol ?? null,
      pnl_delta: payload.pnl_delta ?? null,
      exposure_value: payload.exposure_value ?? null,
      quantity: payload.quantity ?? null,
      price: payload.price ?? null,
      metadata_json: payload.metadata ?? {},
      occurred_at: payload.occurred_at ?? new Date().toISOString(),
      idempotency_key: payload.idempotency_key,
    })
    .select('*')
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Unable to persist event' }, { status: 500 });
  }

  const processed = await processRiskTradeEvent({
    id: data.id,
    account_id: data.account_id,
    event_type: data.event_type,
    symbol: data.symbol,
    pnl_delta: data.pnl_delta,
    exposure_value: data.exposure_value,
    quantity: data.quantity,
    price: data.price,
    metadata: data.metadata_json,
    occurred_at: data.occurred_at,
    idempotency_key: data.idempotency_key,
  } as RiskTradeEvent);

  return NextResponse.json({ data: { accepted: true, processed } }, { status: 202 });
}
