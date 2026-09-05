import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Layer 4 of the isolation model — the scoped data-access layer.
 *
 * Route handlers reach the database as the signed-in user, so RLS constrains
 * them (layer 2). Background work cannot: crons, ingestion and the reviewer run
 * with no session at all, so they must use the service role — which holds
 * BYPASSRLS and is therefore *not* constrained by any policy. For that code
 * path RLS is not a safety net, and `createAdminClient()` used directly is a
 * cross-tenant query waiting to be written.
 *
 * This wrapper is the substitute guarantee: you cannot obtain a query builder
 * without naming a tenant, and every read is filtered and every write stamped
 * with that tenant before the caller sees the builder. The failure mode it
 * removes is not malice, it is a future `.from('accounts').select('*')` written
 * by someone who forgot — which under the service role silently returns every
 * firm's data and looks like it works.
 *
 * Tables that are genuinely global (the shared economic calendar) are listed
 * explicitly and reached through `globalTable()`, so crossing the boundary is
 * a visible, named decision rather than an omission.
 */

/** Reference data shared by every tenant. Not tenant-scoped by design. */
const GLOBAL_TABLES = new Set(['news_events', 'tenants', 'tenant_members', 'tenant_invites']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MissingTenantError extends Error {
  constructor(context: string) {
    super(
      `Tenant-scoped database access attempted without a tenant id (${context}). ` +
        `Background jobs must resolve a tenant before querying; use globalTable() ` +
        `only for genuinely shared reference data.`
    );
    this.name = 'MissingTenantError';
  }
}

function assertTenantId(tenantId: string | null | undefined, context: string): string {
  if (!tenantId || !UUID_RE.test(tenantId)) {
    throw new MissingTenantError(context);
  }
  return tenantId;
}

/**
 * A database handle bound to exactly one tenant. Reads are pre-filtered; writes
 * are stamped. The bound tenant cannot be overridden by the caller — an
 * explicit `tenant_id` in an insert payload is replaced, not merged, so a
 * mistaken or attacker-influenced value cannot redirect the write.
 */
export function tenantDb(tenantId: string, context = 'tenantDb') {
  const id = assertTenantId(tenantId, context);
  const sb = createAdminClient();

  return {
    tenantId: id,

    /** SELECT, pre-filtered to this tenant. */
    from(table: string) {
      if (GLOBAL_TABLES.has(table)) {
        throw new Error(
          `${table} is global reference data — use globalTable('${table}') instead of tenantDb().from()`
        );
      }
      return sb.from(table).select('*').eq('tenant_id', id);
    },

    /** SELECT with an explicit column list, pre-filtered to this tenant. */
    select(table: string, columns: string, options?: { count?: 'exact' | 'planned' | 'estimated' }) {
      if (GLOBAL_TABLES.has(table)) {
        throw new Error(
          `${table} is global reference data — use globalTable('${table}') instead of tenantDb().select()`
        );
      }
      return sb.from(table).select(columns, options).eq('tenant_id', id);
    },

    /** INSERT, stamped with this tenant. Accepts one row or many. */
    insert<T extends Record<string, unknown>>(table: string, rows: T | T[]) {
      const stamped = (Array.isArray(rows) ? rows : [rows]).map((row) => ({
        ...row,
        tenant_id: id,
      }));
      return sb.from(table).insert(stamped);
    },

    /** UPDATE, constrained to this tenant. The tenant stamp cannot be changed. */
    update<T extends Record<string, unknown>>(table: string, patch: T) {
      const { tenant_id: _discarded, ...safe } = patch as Record<string, unknown>;
      return sb.from(table).update(safe).eq('tenant_id', id);
    },

    /** UPSERT, stamped with this tenant. */
    upsert<T extends Record<string, unknown>>(
      table: string,
      rows: T | T[],
      options?: { onConflict?: string }
    ) {
      const stamped = (Array.isArray(rows) ? rows : [rows]).map((row) => ({
        ...row,
        tenant_id: id,
      }));
      return sb.from(table).upsert(stamped, options);
    },

    /** DELETE, constrained to this tenant. */
    delete(table: string) {
      return sb.from(table).delete().eq('tenant_id', id);
    },

    /** Escape hatch for RPCs. The tenant id is injected into the arguments. */
    rpc(fn: string, args: Record<string, unknown> = {}) {
      return sb.rpc(fn, { ...args, p_tenant_id: id });
    },
  };
}

/**
 * Reach a genuinely global table. Named separately so that crossing the tenant
 * boundary is always a deliberate, greppable act.
 */
export function globalTable(table: string) {
  if (!GLOBAL_TABLES.has(table)) {
    throw new Error(
      `${table} is tenant-scoped — use tenantDb(tenantId).from('${table}'). ` +
        `If it truly is global, add it to GLOBAL_TABLES with a reason.`
    );
  }
  return createAdminClient().from(table);
}

/**
 * Every active tenant, for cron fan-out. The only legitimate way to iterate
 * across tenants: do this once at the top of a job, then work inside
 * `tenantDb(tenant.id)` per tenant so no query is ever unscoped.
 */
export async function listActiveTenantIds(): Promise<string[]> {
  const { data, error } = await createAdminClient()
    .from('tenants')
    .select('id')
    .eq('status', 'active');

  if (error) throw error;
  return (data ?? []).map((row: { id: string }) => row.id);
}
