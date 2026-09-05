import { createHash, randomBytes } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Invite issuance and redemption.
 *
 * The redeem path is the security-critical half: an invite must be redeemable
 * into the tenant it was issued for and NO OTHER. That is enforced by
 * construction, not by a check — `redeemInvite` takes only the raw token, the
 * tenant comes back out of the `tenant_invites` row the token hashes to, and
 * there is no parameter anywhere in this module through which a caller could
 * name a different tenant. Only the token's hash is ever stored (`token_hash`
 * on `tenant_invites`), so a leaked database dump cannot be used to redeem
 * outstanding invites — the raw token exists only in the email.
 */

export const INVITABLE_ROLES = ['admin', 'risk_manager', 'risk_analyst', 'viewer'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

const INVITE_TTL_HOURS = 72;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreateInviteInput {
  tenantId: string;
  email: string;
  role: InvitableRole;
  invitedBy: string;
}

export interface CreateInviteResult {
  inviteId: string;
  /** Raw token — send this in the email, never persist it. */
  token: string;
  expiresAt: string;
}

export async function createInvite(input: CreateInviteInput): Promise<CreateInviteResult> {
  const sb = createAdminClient();
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await sb
    .from('tenant_invites')
    .insert({
      tenant_id: input.tenantId,
      email: input.email.toLowerCase(),
      role: input.role,
      token_hash: tokenHash,
      invited_by: input.invitedBy,
      expires_at: expiresAt,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('Failed to create invite');

  return { inviteId: data.id, token, expiresAt };
}

export class InvalidInviteError extends Error {
  constructor(reason: string) {
    super(`Invite is not redeemable: ${reason}`);
    this.name = 'InvalidInviteError';
  }
}

export interface RedeemInviteInput {
  /** Raw token from the acceptance link. Never a tenant id — see module doc. */
  token: string;
  password: string;
}

export interface RedeemInviteResult {
  tenantId: string;
  role: string;
  userId: string;
  email: string;
}

export async function redeemInvite(input: RedeemInviteInput): Promise<RedeemInviteResult> {
  const sb = createAdminClient();
  const tokenHash = hashToken(input.token);

  const { data: invite, error } = await sb
    .from('tenant_invites')
    .select('id, tenant_id, email, role, expires_at, accepted_at, invited_by')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error) throw error;
  if (!invite) throw new InvalidInviteError('token not found');
  if (invite.accepted_at) throw new InvalidInviteError('already accepted');
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    throw new InvalidInviteError('expired');
  }

  const { data: created, error: createUserError } = await sb.auth.admin.createUser({
    email: invite.email,
    password: input.password,
    email_confirm: true,
    app_metadata: { tenant_id: invite.tenant_id, role: invite.role },
  });
  if (createUserError || !created?.user) {
    throw createUserError ?? new Error('Failed to create invited user');
  }

  const { error: memberError } = await sb.from('tenant_members').insert({
    tenant_id: invite.tenant_id,
    user_id: created.user.id,
    role: invite.role,
    invited_by: invite.invited_by,
  });
  if (memberError) throw memberError;

  // Marked accepted last, after the account genuinely exists — if user
  // creation above fails, the invite stays redeemable rather than being
  // burned on a half-completed signup.
  const { error: acceptError } = await sb
    .from('tenant_invites')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', invite.id);
  if (acceptError) throw acceptError;

  return { tenantId: invite.tenant_id, role: invite.role, userId: created.user.id, email: invite.email };
}
