import { createHash, randomBytes } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Ingest-key issuance and verification for the equity-snapshot push path
 * (src/app/api/ingest/equity-snapshots).
 *
 * A firm's bridge process authenticates with a bearer key, not a session —
 * there is no signed-in user on a machine-to-machine request. Only the
 * SHA-256 hash is ever persisted (`ingest_keys.key_hash`), mirroring
 * `src/lib/tenancy/invites.ts`'s token handling: the raw key exists only in
 * the response to whoever minted it, so a leaked database dump yields no
 * usable credential.
 *
 * `verifyIngestKey` necessarily reaches the database directly (not through
 * `tenantDb()`) because, unlike every other background write in this
 * codebase, the caller's tenant is exactly what this function is resolving —
 * there is nothing to scope the lookup by yet. This is the same shape as
 * `redeemInvite`: a global lookup by hash, then everything downstream of it
 * uses the tenant that comes back.
 */

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export interface CreateIngestKeyInput {
  tenantId: string;
  label?: string;
  createdBy: string;
}

export interface CreateIngestKeyResult {
  id: string;
  /** Raw key — return this to the caller once, never persisted. */
  key: string;
  label: string | null;
}

export async function createIngestKey(input: CreateIngestKeyInput): Promise<CreateIngestKeyResult> {
  const sb = createAdminClient();
  const key = `isk_${randomBytes(32).toString('hex')}`;
  const keyHash = hashKey(key);

  const { data, error } = await sb
    .from('ingest_keys')
    .insert({
      tenant_id: input.tenantId,
      key_hash: keyHash,
      label: input.label ?? null,
      created_by: input.createdBy,
    })
    .select('id, label')
    .single();
  if (error || !data) throw error ?? new Error('Failed to create ingest key');

  return { id: data.id, key, label: data.label };
}

export interface VerifiedIngestKey {
  tenantId: string;
  keyId: string;
}

/**
 * Resolve a raw bearer key to its owning tenant. Returns null for anything
 * that is not a live, unrevoked key — not found, revoked, or (belt-and-
 * braces) malformed — so the caller has exactly one failure mode to handle
 * (401), rather than needing to distinguish "no such key" from "revoked".
 */
export async function verifyIngestKey(rawKey: string): Promise<VerifiedIngestKey | null> {
  if (!rawKey || typeof rawKey !== 'string') return null;

  const sb = createAdminClient();
  const keyHash = hashKey(rawKey);

  const { data, error } = await sb
    .from('ingest_keys')
    .select('id, tenant_id, revoked_at')
    .eq('key_hash', keyHash)
    .maybeSingle();
  if (error || !data || data.revoked_at) return null;

  // Best-effort usage tracking; never block or fail the request on it.
  await sb
    .from('ingest_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(
      () => {},
      () => {}
    );

  return { tenantId: data.tenant_id, keyId: data.id };
}
