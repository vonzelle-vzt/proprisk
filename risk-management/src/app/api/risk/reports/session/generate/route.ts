import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { generateSessionReportBodySchema, validationErrorResponse } from '@/lib/api/schemas';
import { requireRiskUser } from '@/lib/auth/guards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function startOfDayIso(date: string): string {
  return `${date}T00:00:00.000Z`;
}

function endOfDayIso(date: string): string {
  return `${date}T23:59:59.999Z`;
}

export async function POST(request: NextRequest) {
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = generateSessionReportBodySchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  const sessionDate = parsed.data.session_date || new Date().toISOString().split('T')[0];
  const accountId = parsed.data.account_id;
  const supabase = await createClient();

  const [decisionsRes, violationsRes, eventsRes] = await Promise.all([
    supabase
      .from('risk_pretrade_decisions')
      .select('result')
      .eq('account_id', accountId)
      .gte('created_at', startOfDayIso(sessionDate))
      .lte('created_at', endOfDayIso(sessionDate)),
    supabase
      .from('risk_violations')
      .select('severity')
      .eq('account_id', accountId)
      .gte('created_at', startOfDayIso(sessionDate))
      .lte('created_at', endOfDayIso(sessionDate)),
    supabase
      .from('risk_trade_events')
      .select('pnl_delta')
      .eq('account_id', accountId)
      .gte('occurred_at', startOfDayIso(sessionDate))
      .lte('occurred_at', endOfDayIso(sessionDate)),
  ]);

  if (decisionsRes.error || violationsRes.error || eventsRes.error) {
    return NextResponse.json(
      {
        error:
          decisionsRes.error?.message || violationsRes.error?.message || eventsRes.error?.message,
      },
      { status: 500 }
    );
  }

  const decisions = decisionsRes.data || [];
  const violations = violationsRes.data || [];
  const events = eventsRes.data || [];

  const passCount = decisions.filter((d) => d.result === 'pass').length;
  const warnCount = decisions.filter((d) => d.result === 'warn').length;
  const blockCount = decisions.filter((d) => d.result === 'block').length;
  const complianceScore = decisions.length > 0 ? Math.round((passCount / decisions.length) * 100) : 0;

  const pnlSeries = events.map((e) => Number(e.pnl_delta ?? 0));
  let running = 0;
  let maxDrawdown = 0;
  for (const point of pnlSeries) {
    running += point;
    maxDrawdown = Math.min(maxDrawdown, running);
  }

  const reportPayload = {
    totals: {
      decisions: decisions.length,
      violations: violations.length,
      compliance_score: complianceScore,
      max_drawdown: Math.abs(maxDrawdown),
    },
    breakdown: {
      pass: passCount,
      warn: warnCount,
      block: blockCount,
      critical_violations: violations.filter((v) => v.severity === 'critical').length,
    },
  };

  const { data, error } = await supabase
    .from('risk_session_reports')
    .upsert(
      {
        tenant_id: auth.tenantId,
        account_id: accountId,
        session_date: sessionDate,
        status: 'ready',
        metrics_json: reportPayload,
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,session_date' }
    )
    .select('*')
    .single();

  if (error) return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
