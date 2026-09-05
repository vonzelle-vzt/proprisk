import { createAdminClient } from '@/lib/supabase/admin';
import { tenantDb } from '@/lib/db/tenant-scoped';
import { ALL_PROVIDER_IDS, getProviderConfig } from '@/lib/providers/registry';

/**
 * Auto-attached ticket context — CRITICAL DETAIL from the brief. A ticket
 * should arrive already debuggable: which tenant, on which plan, with which
 * provider connections live, on which build, and what the app was doing
 * right before the click. Every piece here is best-effort: a missing piece
 * must never block filing the ticket itself, so nothing in this module
 * throws past `gatherDiagnostics`.
 */

export interface TicketDiagnostics {
  tenant: { id: string; name: string; planTier: string } | null;
  appVersion: string | null;
  connections: Array<{ provider: string; enabled: boolean }>;
  recentErrors: Array<{ action: string; occurredAt: string }>;
}

async function tenantSnapshot(tenantId: string): Promise<TicketDiagnostics['tenant']> {
  try {
    const { data } = await createAdminClient()
      .from('tenants')
      .select('id, name, plan_tier')
      .eq('id', tenantId)
      .maybeSingle();
    return data ? { id: data.id, name: data.name, planTier: data.plan_tier } : null;
  } catch {
    return null;
  }
}

function connectionStatus(): TicketDiagnostics['connections'] {
  return ALL_PROVIDER_IDS.map((id) => ({
    provider: id,
    enabled: getProviderConfig(id).enabled,
  }));
}

function appVersion(): string | null {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ??
    process.env.npm_package_version ??
    null
  );
}

async function recentErrors(tenantId: string): Promise<TicketDiagnostics['recentErrors']> {
  try {
    const { data } = await tenantDb(tenantId, 'support ticket diagnostics')
      .select('audit_log', 'action_type, created_at')
      .or('action_type.ilike.%error%,action_type.ilike.%fail%')
      .order('created_at', { ascending: false })
      .limit(5);
    const rows = (data ?? []) as unknown as Array<{ action_type: string; created_at: string }>;
    return rows.map((row) => ({
      action: row.action_type,
      occurredAt: row.created_at,
    }));
  } catch {
    return [];
  }
}

export async function gatherDiagnostics(tenantId: string): Promise<TicketDiagnostics> {
  const [tenant, errors] = await Promise.all([
    tenantSnapshot(tenantId),
    recentErrors(tenantId),
  ]);

  return {
    tenant,
    appVersion: appVersion(),
    connections: connectionStatus(),
    recentErrors: errors,
  };
}
