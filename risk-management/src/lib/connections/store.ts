import { tenantDb } from '@/lib/db/tenant-scoped';
import { CURRENT_KEY_VERSION, decryptSecrets, encryptSecrets } from '@/lib/crypto/envelope';
import type { AssetClass, ProviderId } from '@/lib/providers/types';

/**
 * CRUD over `connections` — the per-tenant provider-credential table.
 *
 * `encrypted_secrets` never leaves this module in decrypted form except
 * through `getDecryptedConfig`, which exists solely for the provider adapters
 * to authenticate live calls. Every other export redacts: `list`/`get` return
 * a masked preview (last 4 characters of each secret), never the value, and
 * nothing here logs a secret or a decrypted blob.
 */

export type ConnectionStatus = 'unvalidated' | 'valid' | 'invalid';

/** Free-form secret bag: `apiKey` plus provider-specific extras (SYSTEM_UUID, NAME, PASSWORD, ...). */
export type ConnectionSecrets = Record<string, string | undefined>;

interface ConnectionRow {
  id: string;
  tenant_id: string;
  provider_id: string;
  asset_class: AssetClass;
  enabled: boolean;
  api_url: string | null;
  encrypted_secrets: string | null;
  key_version: number;
  status: ConnectionStatus;
  last_validated_at: string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RedactedConnection {
  id: string;
  providerId: ProviderId;
  assetClass: AssetClass;
  enabled: boolean;
  apiUrl: string | null;
  status: ConnectionStatus;
  lastValidatedAt: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Masked previews only, e.g. { apiKey: "****abcd" } — never the real value. */
  secretsPreview: Record<string, string>;
}

export interface UpsertConnectionInput {
  assetClass: AssetClass;
  enabled: boolean;
  apiUrl?: string;
  /** Merged into (not replacing) any existing secrets when omitted per-key. */
  secrets: ConnectionSecrets;
  actor: string;
}

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

function previewSecrets(row: ConnectionRow, tenantId: string): Record<string, string> {
  if (!row.encrypted_secrets) return {};
  try {
    const secrets = decryptSecrets(tenantId, row.encrypted_secrets);
    const preview: Record<string, string> = {};
    for (const [key, value] of Object.entries(secrets)) {
      if (typeof value === 'string' && value) preview[key] = maskSecret(value);
    }
    return preview;
  } catch {
    // A row that fails to decrypt (wrong master key, corruption) should still
    // show up in the list — silently as "unreadable" — rather than take down
    // the whole connections page.
    return { _error: 'unreadable' };
  }
}

function redact(row: ConnectionRow, tenantId: string): RedactedConnection {
  return {
    id: row.id,
    providerId: row.provider_id as ProviderId,
    assetClass: row.asset_class,
    enabled: row.enabled,
    apiUrl: row.api_url,
    status: row.status,
    lastValidatedAt: row.last_validated_at,
    lastError: row.last_error,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    secretsPreview: previewSecrets(row, tenantId),
  };
}

export async function listConnections(tenantId: string): Promise<RedactedConnection[]> {
  const db = tenantDb(tenantId, 'connections.list');
  const { data, error } = await db.from('connections').order('provider_id', { ascending: true });
  if (error) throw error;
  return ((data as ConnectionRow[]) || []).map((row) => redact(row, tenantId));
}

export async function getConnection(
  tenantId: string,
  providerId: ProviderId
): Promise<RedactedConnection | null> {
  const db = tenantDb(tenantId, 'connections.get');
  const { data, error } = await db.from('connections').eq('provider_id', providerId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return redact(data as ConnectionRow, tenantId);
}

/**
 * Decrypted credentials for one tenant+provider, shaped for the adapter layer
 * (src/lib/providers/registry.ts). Returns null when no connection row exists
 * yet — callers fall back to env-based config so a tenant with nothing
 * provisioned doesn't hard-fail (self-hosted / pre-connections deployments).
 */
export async function getDecryptedConfig(
  tenantId: string,
  providerId: ProviderId
): Promise<{ enabled: boolean; apiUrl?: string; secrets: ConnectionSecrets } | null> {
  const db = tenantDb(tenantId, 'connections.getDecryptedConfig');
  const { data, error } = await db.from('connections').eq('provider_id', providerId).maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as ConnectionRow;
  const secrets = row.encrypted_secrets ? (decryptSecrets(tenantId, row.encrypted_secrets) as ConnectionSecrets) : {};
  return { enabled: row.enabled, apiUrl: row.api_url || undefined, secrets };
}

export async function upsertConnection(
  tenantId: string,
  providerId: ProviderId,
  input: UpsertConnectionInput
): Promise<RedactedConnection> {
  const db = tenantDb(tenantId, 'connections.upsert');

  // Merge onto existing secrets so a partial update (e.g. rotating just the
  // API key) doesn't blank out the rest of the extras bag.
  const existing = await getDecryptedConfig(tenantId, providerId);
  const mergedSecrets: ConnectionSecrets = { ...(existing?.secrets || {}), ...input.secrets };
  const encrypted = encryptSecrets(tenantId, mergedSecrets, CURRENT_KEY_VERSION);

  const { data, error } = await db.upsert(
    'connections',
    {
      provider_id: providerId,
      asset_class: input.assetClass,
      enabled: input.enabled,
      api_url: input.apiUrl ?? null,
      encrypted_secrets: encrypted,
      key_version: CURRENT_KEY_VERSION,
      status: 'unvalidated' as ConnectionStatus,
      created_by: input.actor,
    },
    { onConflict: 'tenant_id,provider_id' }
  ).select('*').single();

  if (error) throw error;
  return redact(data as ConnectionRow, tenantId);
}

export async function recordValidationResult(
  tenantId: string,
  providerId: ProviderId,
  result: { ok: boolean; error?: string }
): Promise<void> {
  const db = tenantDb(tenantId, 'connections.recordValidationResult');
  const { error } = await db
    .update('connections', {
      status: (result.ok ? 'valid' : 'invalid') as ConnectionStatus,
      last_validated_at: new Date().toISOString(),
      last_error: result.ok ? null : result.error?.slice(0, 2000) || 'Validation failed',
    })
    .eq('provider_id', providerId);
  if (error) throw error;
}

export async function deleteConnection(tenantId: string, providerId: ProviderId): Promise<void> {
  const db = tenantDb(tenantId, 'connections.delete');
  const { error } = await db.delete('connections').eq('provider_id', providerId);
  if (error) throw error;
}
