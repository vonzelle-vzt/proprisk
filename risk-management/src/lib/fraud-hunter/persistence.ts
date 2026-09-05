import { tenantDb } from '@/lib/db/tenant-scoped';
import { logError } from '@/lib/logging/logger';
import type { FraudType, FraudStatus, FraudFinding, FraudInvestigation } from '@/types/fraud';

/**
 * Upsert a fraud investigation on (tenant_id, dedupe_key).
 * Only creates/updates if no existing record or existing status is 'open'.
 * Returns null if a duplicate already exists in dismissed/confirmed/actioned state.
 *
 * Unlike the read/update helpers below, this does not swallow a database
 * error into a null return — a write failure here silently discards a fraud
 * finding, so it is thrown for the caller (`runFraudHunterScan`) to count and
 * surface rather than mistake for "no new investigation".
 */
export async function upsertFraudInvestigation(
  tenantId: string,
  fraudType: FraudType,
  finding: FraudFinding
): Promise<FraudInvestigation | null> {
  const db = tenantDb(tenantId, 'fraud-hunter upsertFraudInvestigation');

  // Check for existing record with this dedupe_key
  const { data: existing } = await db
    .select('fraud_investigations', 'id, status')
    .eq('dedupe_key', finding.dedupe_key)
    .returns<{ id: string; status: string }[]>()
    .maybeSingle();

  // If exists and not 'open', skip — already handled
  if (existing && existing.status !== 'open') {
    return null;
  }

  const now = new Date().toISOString();
  const row = {
    fraud_type: fraudType,
    severity: finding.severity,
    status: 'open' as FraudStatus,
    confidence_score: finding.confidence_score,
    account_ids: finding.account_ids,
    user_ids: finding.user_ids,
    primary_account: finding.primary_account,
    title: finding.title,
    summary: finding.summary,
    evidence: finding.evidence,
    total_amount_at_risk: finding.total_amount_at_risk,
    recommended_action: finding.recommended_action,
    dedupe_key: finding.dedupe_key,
    detected_at: now,
    updated_at: now,
  };

  // tenantDb().upsert() stamps tenant_id itself; the conflict target is the
  // composite unique index from migration 00015 (`uq_fraud_dedupe` on
  // `(tenant_id, dedupe_key)`), not the old single-column `dedupe_key`.
  const { data, error } = await db
    .upsert('fraud_investigations', row, { onConflict: 'tenant_id,dedupe_key' })
    .select()
    .maybeSingle();

  if (error) {
    logError('Failed to upsert fraud investigation', error, {
      route: 'lib/fraud-hunter/persistence',
      category: 'database',
      tenant_id: tenantId,
    });
    throw error;
  }

  return data as FraudInvestigation;
}

/**
 * Query fraud investigations with optional filters.
 */
export async function getFraudInvestigations(
  tenantId: string,
  filters?: {
    status?: FraudStatus[];
    fraud_type?: FraudType[];
    severity?: string[];
    limit?: number;
    offset?: number;
  }
): Promise<FraudInvestigation[]> {
  const db = tenantDb(tenantId, 'fraud-hunter getFraudInvestigations');

  try {
    let query = db
      .from('fraud_investigations')
      .order('detected_at', { ascending: false });

    if (filters?.status?.length) {
      query = query.in('status', filters.status);
    }
    if (filters?.fraud_type?.length) {
      query = query.in('fraud_type', filters.fraud_type);
    }
    if (filters?.severity?.length) {
      query = query.in('severity', filters.severity);
    }

    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;

    if (error) {
      logError('Failed to fetch fraud investigations', error, {
        route: 'lib/fraud-hunter/persistence',
        category: 'database',
        tenant_id: tenantId,
      });
      return [];
    }

    return (data || []) as FraudInvestigation[];
  } catch (err) {
    logError('Unexpected error fetching fraud investigations', err, {
      route: 'lib/fraud-hunter/persistence',
      category: 'database',
      tenant_id: tenantId,
    });
    return [];
  }
}

/**
 * Get a single fraud investigation by ID.
 */
export async function getFraudInvestigation(
  tenantId: string,
  id: string
): Promise<FraudInvestigation | null> {
  const db = tenantDb(tenantId, 'fraud-hunter getFraudInvestigation');

  try {
    const { data, error } = await db
      .from('fraud_investigations')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      logError('Failed to fetch fraud investigation', error, {
        route: 'lib/fraud-hunter/persistence',
        category: 'database',
        tenant_id: tenantId,
        account_id: id,
      });
      return null;
    }

    return data as FraudInvestigation | null;
  } catch (err) {
    logError('Unexpected error fetching fraud investigation', err, {
      route: 'lib/fraud-hunter/persistence',
      category: 'database',
      tenant_id: tenantId,
    });
    return null;
  }
}

/**
 * Update investigation status. Sets resolved_at/resolved_by when confirming/dismissing/actioning.
 */
export async function updateInvestigationStatus(
  tenantId: string,
  id: string,
  status: FraudStatus,
  resolvedBy?: string,
  notes?: string
): Promise<boolean> {
  const db = tenantDb(tenantId, 'fraud-hunter updateInvestigationStatus');

  try {
    const now = new Date().toISOString();
    const isResolution = status === 'confirmed' || status === 'dismissed' || status === 'actioned';

    const update: Record<string, unknown> = {
      status,
      updated_at: now,
    };

    if (isResolution) {
      update.resolved_at = now;
      update.resolved_by = resolvedBy || null;
      update.resolution_notes = notes || null;
    }

    const { error } = await db
      .update('fraud_investigations', update)
      .eq('id', id);

    if (error) {
      logError('Failed to update investigation status', error, {
        route: 'lib/fraud-hunter/persistence',
        category: 'database',
        tenant_id: tenantId,
      });
      return false;
    }

    return true;
  } catch (err) {
    logError('Unexpected error updating investigation status', err, {
      route: 'lib/fraud-hunter/persistence',
      category: 'database',
      tenant_id: tenantId,
    });
    return false;
  }
}

/**
 * Get all investigations where account_ids array contains the given accountId.
 */
export async function getInvestigationsByAccount(
  tenantId: string,
  accountId: string
): Promise<FraudInvestigation[]> {
  const db = tenantDb(tenantId, 'fraud-hunter getInvestigationsByAccount');

  try {
    const { data, error } = await db
      .from('fraud_investigations')
      .contains('account_ids', [accountId])
      .order('detected_at', { ascending: false });

    if (error) {
      logError('Failed to fetch investigations by account', error, {
        route: 'lib/fraud-hunter/persistence',
        category: 'database',
        tenant_id: tenantId,
        account_id: accountId,
      });
      return [];
    }

    return (data || []) as FraudInvestigation[];
  } catch (err) {
    logError('Unexpected error fetching investigations by account', err, {
      route: 'lib/fraud-hunter/persistence',
      category: 'database',
      tenant_id: tenantId,
    });
    return [];
  }
}
