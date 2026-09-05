import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { tenantDb } from '@/lib/db/tenant-scoped';

/**
 * Trader access tokens — issuance, verification, revocation.
 *
 * Mirrors src/lib/tenancy/invites.ts on purpose: same shape of problem (a
 * bearer link that must resolve to exactly one row and nothing wider), same
 * answer (only the sha256 hash is ever persisted; the raw token exists only
 * in the link the firm hands the trader).
 *
 * `verifyTraderToken` is the entire authentication boundary for the trader
 * surface — traders have no Supabase session, so nothing upstream of this
 * function checks anything. It is deliberately the ONLY place in this module
 * that reaches for the admin client: a trader's request carries no tenant
 * claim, so there is nothing for a request-scoped client's RLS to key off,
 * and the token itself is what proves which single (tenant, account) pair the
 * caller may read.
 */

const TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time equality on the hash. Redundant with the `eq('token_hash')`
 * lookup below in practice (an indexed equality match on a high-entropy
 * sha256 hex string leaks nothing exploitable), but the brief calls for it
 * explicitly and it costs nothing: never compare the raw token, always the
 * digest, and never with `===`.
 */
function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface IssueTraderLinkInput {
  tenantId: string;
  accountId: string;
  createdBy: string;
  /** Defaults to 30 days — long enough to cover a challenge, short enough to force rotation. */
  ttlDays?: number;
}

export interface IssuedTraderLink {
  id: string;
  /** Raw token — hand this to the caller once. Never persisted, never logged. */
  token: string;
  expiresAt: string;
}

/**
 * Mint a new trader link for one account. Runs inside the firm's own
 * tenant-scoped write path (the caller already passed `requireRiskManager`),
 * so this uses `tenantDb`, not the admin client — the stamp is enforced by
 * that wrapper the same way every other tenant write is.
 */
export async function issueTraderLink(input: IssueTraderLinkInput): Promise<IssuedTraderLink> {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(token);
  const ttlDays = input.ttlDays ?? 30;
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

  const db = tenantDb(input.tenantId, 'issueTraderLink');
  const { data, error } = await db
    .insert('trader_access_tokens', {
      account_id: input.accountId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      created_by: input.createdBy,
    })
    .select('id')
    .single();

  if (error || !data) throw error ?? new Error('Failed to issue trader link');
  return { id: (data as { id: string }).id, token, expiresAt };
}

/** Revoke one link. Scoped to the firm's own tenant, like every other write here. */
export async function revokeTraderLink(tenantId: string, tokenId: string): Promise<void> {
  const db = tenantDb(tenantId, 'revokeTraderLink');
  const { error } = await db
    .update('trader_access_tokens', { revoked_at: new Date().toISOString() })
    .eq('id', tokenId);
  if (error) throw error;
}

export interface TraderLinkSummary {
  id: string;
  accountId: string;
  expiresAt: string;
  revokedAt: string | null;
  lastViewedAt: string | null;
  createdAt: string;
}

/** Every link issued for one account, for the firm's own management screen. */
export async function listTraderLinks(
  tenantId: string,
  accountId: string
): Promise<TraderLinkSummary[]> {
  const db = tenantDb(tenantId, 'listTraderLinks');
  const { data, error } = await db
    .select(
      'trader_access_tokens',
      'id, account_id, expires_at, revoked_at, last_viewed_at, created_at'
    )
    .eq('account_id', accountId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  return (data ?? []).map((row) => {
    const r = row as unknown as {
      id: string;
      account_id: string;
      expires_at: string;
      revoked_at: string | null;
      last_viewed_at: string | null;
      created_at: string;
    };
    return {
      id: r.id,
      accountId: r.account_id,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
      lastViewedAt: r.last_viewed_at,
      createdAt: r.created_at,
    };
  });
}

export interface VerifiedTraderAccess {
  tokenId: string;
  tenantId: string;
  accountId: string;
}

/**
 * Verify a raw token from a trader-facing URL. Returns null for anything
 * that isn't a currently-valid, unrevoked, unexpired token — the caller
 * (the trader API route) must treat null as an undifferentiated 404: telling
 * an attacker "expired" vs "revoked" vs "never existed" narrows their search.
 */
export async function verifyTraderToken(rawToken: string): Promise<VerifiedTraderAccess | null> {
  if (!rawToken || rawToken.length < 32) return null;

  const tokenHash = hashToken(rawToken);
  const sb = createAdminClient();

  const { data, error } = await sb
    .from('trader_access_tokens')
    .select('id, tenant_id, account_id, token_hash, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as {
    id: string;
    tenant_id: string;
    account_id: string;
    token_hash: string;
    expires_at: string;
    revoked_at: string | null;
  };

  if (!hashesMatch(tokenHash, row.token_hash)) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  // Best-effort visibility for the firm ("has the trader looked at this?").
  // Never blocks or fails the read that triggered it.
  try {
    await sb
      .from('trader_access_tokens')
      .update({ last_viewed_at: new Date().toISOString() })
      .eq('id', row.id);
  } catch {
    // Non-fatal: the trader still gets their page even if this write fails.
  }

  return { tokenId: row.id, tenantId: row.tenant_id, accountId: row.account_id };
}
