import { createAdminClient } from '@/lib/supabase/admin';
import type { RiskAlertStatus, RiskSeverity, RiskTradeEvent } from '@/types/risk';

function deriveSeverity(absPnlDelta: number): RiskSeverity {
  if (absPnlDelta >= 1000) return 'critical';
  if (absPnlDelta >= 500) return 'high';
  if (absPnlDelta >= 200) return 'medium';
  return 'low';
}

function inferAlertStatus(severity: RiskSeverity): RiskAlertStatus {
  return severity === 'low' ? 'acknowledged' : 'new';
}

export async function processRiskTradeEvent(event: RiskTradeEvent): Promise<boolean> {
  const supabase = createAdminClient();
  const absPnlDelta = Math.abs(event.pnl_delta ?? 0);

  if (absPnlDelta < 200) {
    return true;
  }

  const severity = deriveSeverity(absPnlDelta);
  const violationType = absPnlDelta >= 1000 ? 'max_daily_loss' : 'max_position_risk_pct';
  const alertStatus = inferAlertStatus(severity);

  const { data: existing } = await supabase
    .from('risk_alerts')
    .select('id')
    .eq('account_id', event.account_id)
    .eq('dedupe_key', event.idempotency_key)
    .limit(1);

  if (existing && existing.length > 0) {
    return true;
  }

  const { data: violation, error: violationError } = await supabase
    .from('risk_violations')
    .insert({
      account_id: event.account_id,
      source_event_id: event.id,
      violation_type: violationType,
      severity,
      status: severity === 'critical' ? 'open' : 'monitoring',
      details_json: {
        pnl_delta: event.pnl_delta,
        symbol: event.symbol,
        event_type: event.event_type,
      },
    })
    .select('id')
    .single();

  if (violationError || !violation) {
    return false;
  }

  const { error: alertError } = await supabase.from('risk_alerts').insert({
    account_id: event.account_id,
    violation_id: violation.id,
    severity,
    status: alertStatus,
    title: `${severity.toUpperCase()} ${violationType} detected`,
    message: `Account event ${event.event_type} triggered ${violationType}.`,
    dedupe_key: event.idempotency_key,
  });

  if (alertError) {
    return false;
  }

  return true;
}
