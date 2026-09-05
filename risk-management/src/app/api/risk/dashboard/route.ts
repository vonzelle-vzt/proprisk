import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';

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

  const [profileRes, decisionsRes, alertsRes, violationsRes] = await Promise.all([
    supabase
      .from('risk_profiles')
      .select('id, name, status, updated_at')
      .eq('account_id', accountId)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle(),
    supabase
      .from('risk_pretrade_decisions')
      .select('result, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('risk_alerts')
      .select('id, severity, status, title, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase
      .from('risk_violations')
      .select('id, severity, status, violation_type, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  if (profileRes.error || decisionsRes.error || alertsRes.error || violationsRes.error) {
    return NextResponse.json(
      {
        error:
          profileRes.error?.message ||
          decisionsRes.error?.message ||
          alertsRes.error?.message ||
          violationsRes.error?.message,
      },
      { status: 500 }
    );
  }

  const decisions = decisionsRes.data || [];
  const decisionSummary = {
    pass: decisions.filter((d) => d.result === 'pass').length,
    warn: decisions.filter((d) => d.result === 'warn').length,
    block: decisions.filter((d) => d.result === 'block').length,
  };
  const totalDecisions = Math.max(1, decisions.length);
  const complianceScore = Math.round((decisionSummary.pass / totalDecisions) * 100);

  return NextResponse.json({
    data: {
      active_profile: profileRes.data || null,
      compliance_score: complianceScore,
      decision_summary: decisionSummary,
      recent_alerts: alertsRes.data || [],
      recent_violations: violationsRes.data || [],
      lockout_active: (alertsRes.data || []).some(
        (alert) => alert.severity === 'critical' && alert.status !== 'resolved'
      ),
    },
  });
}
