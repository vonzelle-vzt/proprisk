import { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

/**
 * Guards for tenancy-management surfaces (invites, roster). Deliberately
 * separate from `requireRiskUser`/`requireRiskManager` in
 * `src/lib/auth/guards.ts`: those gate the risk desk and never admit
 * `owner` (owner has no reason to touch violations/payouts), while roster
 * management is owner|admin work and has no reason to admit risk_analyst.
 * Sharing one allowlist between the two surfaces would eventually give one
 * the other's permissions by accident.
 */

type GuardResult =
  | { ok: true; user: User; role: string; tenantId: string }
  | { ok: false; response: NextResponse };

async function currentUser(): Promise<
  { ok: true; user: User } | { ok: false; response: NextResponse }
> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  return { ok: true, user: data.user };
}

function claim(user: User, key: 'role' | 'tenant_id'): string {
  const raw = user.app_metadata?.[key];
  return typeof raw === 'string' ? raw : '';
}

/** Owner or admin of their own tenant — invite teammates, manage the roster. */
export async function requireTenantAdmin(): Promise<GuardResult> {
  const auth = await currentUser();
  if (!auth.ok) return auth;

  const role = claim(auth.user, 'role');
  if (role !== 'owner' && role !== 'admin') {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  const tenantId = claim(auth.user, 'tenant_id');
  if (!tenantId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden: no tenant' }, { status: 403 }),
    };
  }

  return { ok: true, user: auth.user, role, tenantId };
}

/** Any signed-in member of a tenant — used for the support-ticket surface. */
export async function requireTenantMember(): Promise<GuardResult> {
  const auth = await currentUser();
  if (!auth.ok) return auth;

  const tenantId = claim(auth.user, 'tenant_id');
  if (!tenantId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden: no tenant' }, { status: 403 }),
    };
  }

  return { ok: true, user: auth.user, role: claim(auth.user, 'role'), tenantId };
}
