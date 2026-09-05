import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Signup provisioning: a firm signing up gets its own tenant + a single
 * `owner` account, atomically enough that we never end up with a tenant and
 * no one able to log into it.
 *
 * CRITICAL: the tenant claim is written to `app_metadata` via the Supabase
 * admin API's `createUser({ app_metadata })`, never `user_metadata` — RLS's
 * `auth_tenant_id()` (00015_tenancy.sql) reads app_metadata specifically
 * because it is not user-editable. Writing the claim anywhere else would
 * pass typechecking and silently grant no access at all.
 *
 * We never hold the firm's password beyond this call: it goes straight into
 * `auth.admin.createUser`, which hashes and discards it exactly like a normal
 * signup would.
 */

export class SlugDerivationError extends Error {}

function baseSlug(firmName: string): string {
  const slug = firmName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'firm';
}

const MAX_SLUG_ATTEMPTS = 50;

/**
 * Numeric collision suffix (firm, firm-2, firm-3, ...) rather than a random
 * one: it keeps the public identifier predictable and the retry bounded, so
 * a genuinely broken query fails loudly instead of spinning forever.
 */
async function deriveUniqueSlug(
  sb: ReturnType<typeof createAdminClient>,
  firmName: string
): Promise<string> {
  const base = baseSlug(firmName);

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const { data, error } = await sb
      .from('tenants')
      .select('id')
      .eq('slug', candidate)
      .maybeSingle();
    if (error) throw error;
    if (!data) return candidate;
  }

  throw new SlugDerivationError(
    `Could not derive a unique slug for "${firmName}" after ${MAX_SLUG_ATTEMPTS} attempts`
  );
}

export interface ProvisionTenantInput {
  firmName: string;
  ownerEmail: string;
  ownerPassword: string;
}

export interface ProvisionTenantResult {
  tenantId: string;
  slug: string;
  userId: string;
}

export async function provisionTenant(input: ProvisionTenantInput): Promise<ProvisionTenantResult> {
  const sb = createAdminClient();
  const slug = await deriveUniqueSlug(sb, input.firmName);

  const { data: tenant, error: tenantError } = await sb
    .from('tenants')
    .insert({ name: input.firmName, slug })
    .select('id')
    .single();
  if (tenantError || !tenant) {
    throw tenantError ?? new Error('Failed to create tenant');
  }

  // There is no single transaction spanning auth.users and public.tenants, so
  // a failure creating the owner or the membership row is cleaned up manually
  // rather than left as a tenant nobody can sign into.
  try {
    const { data: created, error: createUserError } = await sb.auth.admin.createUser({
      email: input.ownerEmail,
      password: input.ownerPassword,
      email_confirm: true,
      app_metadata: { tenant_id: tenant.id, role: 'owner' },
    });
    if (createUserError || !created?.user) {
      throw createUserError ?? new Error('Failed to create owner account');
    }

    const { error: memberError } = await sb.from('tenant_members').insert({
      tenant_id: tenant.id,
      user_id: created.user.id,
      role: 'owner',
    });
    if (memberError) throw memberError;

    return { tenantId: tenant.id, slug, userId: created.user.id };
  } catch (err) {
    await sb.from('tenants').delete().eq('id', tenant.id);
    throw err;
  }
}
