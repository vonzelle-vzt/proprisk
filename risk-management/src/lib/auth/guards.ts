import { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

const ALLOWED_RISK_ROLES = new Set(['risk_analyst', 'risk_manager', 'admin']);

type RequireRiskUserResult =
  | { ok: true; user: User; role: string; actor: string; tenantId: string }
  | { ok: false; response: NextResponse };

/**
 * Human-readable identity for audit trails, deduction records and payout
 * decisions. Email is what a reviewer reading a dispute months later needs;
 * the immutable user id is carried alongside it in the audit `details`.
 */
export function actorLabel(user: User): string {
  return user.email ?? user.id;
}

export async function requireRiskUser(): Promise<RequireRiskUserResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  // Role comes from `app_metadata` ONLY. `user_metadata` is user-editable via
  // supabase.auth.updateUser(), so reading a role from it lets any signed-in
  // user self-assign `admin`. Absence of a role is a denial, not a default —
  // an unprovisioned account gets no access to money-moving surfaces.
  const rawRole = data.user.app_metadata?.role;
  const role = typeof rawRole === 'string' ? rawRole : '';

  if (!ALLOWED_RISK_ROLES.has(role)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }

  // The tenant claim is minted server-side from `tenant_members` at sign-in and
  // invite acceptance; app_metadata is the transport, tenant_members is the
  // source of truth. A session with no tenant claim is not a session with
  // global access — it is unusable, and the RLS predicates agree (a NULL claim
  // fails every policy closed).
  const rawTenant = data.user.app_metadata?.tenant_id;
  const tenantId = typeof rawTenant === 'string' ? rawTenant : '';

  if (!tenantId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden: no tenant' }, { status: 403 }),
    };
  }

  return { ok: true, user: data.user, role, actor: actorLabel(data.user), tenantId };
}

// Enforcement-grade actions (restrict/suspend/flatten accounts, batch
// enforcement) are restricted to risk_manager and admin.
export async function requireRiskManager(): Promise<RequireRiskUserResult> {
  const auth = await requireRiskUser();
  if (!auth.ok) return auth;

  if (auth.role !== 'risk_manager' && auth.role !== 'admin') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Forbidden: requires risk_manager or admin role' },
        { status: 403 }
      ),
    };
  }

  return auth;
}
