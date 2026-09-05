import { tenantDb } from '@/lib/db/tenant-scoped';
import { violationLabel } from '@/lib/violations/labels';

/**
 * Live backing for GET /api/alerts — before this, live mode returned
 * `{ data: [], total: 0 }` unconditionally (no live alerting existed at all).
 * Shape matches the `Alert` interface the alerts page already renders
 * (src/app/(dashboard)/alerts/page.tsx) as closely as the real schema
 * supports: `risk_alerts` (supabase/migrations/00003_risk_engine_tables.sql)
 * carries severity/status/message/title but not provider/assetClass, so those
 * are best-effort (assetClass omitted rather than guessed).
 */
export interface LiveAlert {
  id: string;
  accountId: string;
  login: string;
  type: string;
  label: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  detectedAt: string;
  status: 'active' | 'acknowledged';
}

export async function listLiveAlerts(tenantId: string): Promise<{ data: LiveAlert[]; total: number; active: number }> {
  const db = tenantDb(tenantId, 'listLiveAlerts');

  // risk_alerts.status is 'new' | 'acknowledged' | 'resolved' — the feed only
  // ever shows open work, matching the demo mock (which has no 'resolved').
  const { data: alertRows, error } = await db
    .select('risk_alerts', '*')
    .in('status', ['new', 'acknowledged'])
    .order('severity', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(200);

  if (error || !alertRows || alertRows.length === 0) {
    return { data: [], total: 0, active: 0 };
  }

  const accountIds = Array.from(new Set(alertRows.map((a: any) => a.account_id)));
  const violationIds = Array.from(new Set(alertRows.map((a: any) => a.violation_id).filter(Boolean)));

  const [{ data: accountRows }, { data: violationRows }] = await Promise.all([
    accountIds.length
      ? db.select('accounts', 'id, login').in('id', accountIds)
      : Promise.resolve({ data: [] as any[] }),
    violationIds.length
      ? db.select('risk_violations', 'id, violation_type').in('id', violationIds)
      : Promise.resolve({ data: [] as any[] }),
  ]);

  const loginById = new Map<string, string>((accountRows || []).map((a: any) => [a.id, a.login]));
  const typeById = new Map<string, string>((violationRows || []).map((v: any) => [v.id, v.violation_type]));

  const data: LiveAlert[] = alertRows.map((row: any) => {
    const type = typeById.get(row.violation_id) ?? 'unknown';
    return {
      id: row.id,
      accountId: row.account_id,
      login: loginById.get(row.account_id) ?? row.account_id,
      type,
      label: violationLabel(type),
      severity: row.severity,
      message: row.message ?? row.title,
      detectedAt: row.created_at,
      status: row.status === 'acknowledged' ? 'acknowledged' : 'active',
    };
  });

  return {
    data,
    total: data.length,
    active: data.filter((a) => a.status === 'active').length,
  };
}
