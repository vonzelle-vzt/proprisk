# Skill: tenant isolation

**Use when:** touching anything under `risk-management/src/lib/db/`,
`risk-management/src/lib/auth/`, any Supabase migration, any new route or
cron that reads or writes a tenant-scoped table, or any provider adapter that
holds a token, cache, or queue key.

Load this before writing code, not after — every real defect this system has
had traced to one of the five layers below being skipped, not misapplied.

## The invariant

No firm can see another firm's data. This is a product promise, not a best
effort (`risk-management/docs/ISOLATION.md`), and it is enforced five times
over because any single mechanism dies to one ordinary Friday-afternoon edit.

| Layer | What it is | Defeated by |
|---|---|---|
| 1. Tenant claim | `tenant_id` + `role` in JWT `app_metadata` | reading the claim from `user_metadata` (user-writable via `supabase.auth.updateUser()`) |
| 2. Row-level security | `USING`/`WITH CHECK` policies keyed on `auth_tenant_id()`, on every tenant table | a route using the service-role client |
| 3. Request-scoped DB access | routes use the signed-in user's client, so RLS constrains them | calling `createAdminClient()` directly in a route |
| 4. Scoped data-access layer | `tenantDb(tenantId)` for background jobs — cannot build a query without naming a tenant | making the `tenantId` parameter optional anywhere in the call chain |
| 5. Runtime partitioning | per-tenant credential/token caches, namespaced queue keys, tenant-bounded cross-account scans | a module-scoped cache, a global Redis key, an unscoped correlation across every account in the database |

## Non-negotiable rules

**Never make `tenantId` optional.** Both real cross-tenant defects in this
codebase trace to exactly that — most notably the fraud-hunter detectors,
which took no tenant argument, ran under the service role, and correlated
every account in the database against every other; Firm A would have
received investigations naming Firm B's accounts. A required parameter turns
the compiler into the auditor: it enumerates every call site, and forces the
cascade through every helper up to *its* callers. An optional parameter with
a fallback is how the hole comes back.

**RLS is ROW-level and cannot restrict COLUMNS.** A policy that lets a tenant
owner update their own tenant row lets them update *every column* of it,
including `plan_tier`, an account ceiling, or an enforcement gate you add
later. Protect sensitive columns with an explicit, allowlisted `GRANT`:

```sql
REVOKE UPDATE ON tenants FROM authenticated;
GRANT UPDATE (name, branding_json) ON tenants TO authenticated;
```

Allowlisted, not denylisted — a column added next year is not
customer-writable by default, and nobody has to remember this rule to stay
safe.

**A NULL claim must fail closed.** `auth_tenant_id()` returns NULL when the
JWT carries no tenant, and `tenant_id = NULL` evaluates to NULL, not TRUE —
every policy above refuses by default. Verify this with the isolation test
below rather than assuming it; a claimless token seeing everything is the
worst possible default to discover in production.

**Scope UNIQUE constraints keyed on a value a third party issues.** Two
firms routinely hold the same provider account number, payout id, or
snapshot key. A globally-unique constraint on one of those means the second
firm to onboard fails on insert — and it looks like a mysterious database
error, not a design fault. A constraint keyed on an internal UUID is already
transitively scoped and needs no change.

## Adding a tenant-scoped table — checklist

1. `tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`.
2. Copy the RLS block from `00015_tenancy.sql` verbatim: four
   `authenticated` policies (SELECT/INSERT/UPDATE/DELETE, `WITH CHECK` on
   every write) plus one `service_role` policy, with `ENABLE` **and**
   `FORCE ROW LEVEL SECURITY`. Forcing matters — the table owner bypasses
   RLS otherwise, and migrations run as owner.
3. Lead every index with `tenant_id`.
4. Scope any UNIQUE constraint per the rule above.
5. Run both checks below.

If the table is genuinely global (reference data with no per-tenant
variation), add it to `GLOBAL_TABLES` in **both**
`risk-management/scripts/check-isolation.mjs` and
`risk-management/src/lib/db/tenant-scoped.ts`, with the reason written down.
Making something global should be a decision someone signed, not an
omission.

## The two checks, and what each answers

**`bash risk-management/supabase/tests/verify-isolation.sh`** — *does
isolation actually hold?* Builds a real Postgres 17 from the baseline plus
every migration, then acts as the `authenticated` role with live JWT claims
and asserts: Firm A sees only its own rows; naming Firm B's tenant id
explicitly returns nothing; cross-tenant INSERT and move-via-UPDATE are
refused; a cross-tenant DELETE affects 0 rows; a claimless token sees
nothing. Needs local Postgres on port 55432; it drops and rebuilds its own
database.

**`node risk-management/scripts/check-isolation.mjs`** — *will it still hold
tomorrow?* Static check, runs in CI, fails the build on: a new table missing
`tenant_id`; a `USING (true)` policy for `authenticated`; a route handler
calling `createAdminClient()`; role or tenant read from `user_metadata`. It
skips migrations before `00015` deliberately (that migration replaces every
policy on every tenant table, so a permissive policy in an older file
describes a state that no longer exists).

## What fails CI

- A route under `src/app/api/**` importing `createAdminClient` without being
  on the script's explicit, justified allowlist.
- A new `CREATE TABLE` in a migration with no `tenant_id NOT NULL` and no
  entry in `GLOBAL_TABLES`.
- Any policy for `authenticated` that isn't scoped by `auth_tenant_id()`.
- `user_metadata` appearing anywhere role or tenant is read from
  (`.app_metadata` is the only legal source).
- A function signature that makes a previously-required `tenantId` parameter
  optional.

## Common mistakes

- Adding a background job that calls `tenantDb(id)` once and then reuses the
  same handle across a loop over *other* tenants — each tenant needs its own
  call; `listActiveTenantIds()` is the sanctioned way to fan out.
- Introducing a new provider adapter with a module-scoped cache (`const
  cache = new Map()` at file scope) instead of a `Map` keyed by tenant.
- Trusting a `.eq('tenant_id', ...)` filter written by hand instead of using
  `tenantDb()`, which stamps writes and cannot be constructed without a
  tenant in the first place.
- Assuming asset class or provider implies isolation scope — it does not;
  every one of the five layers applies uniformly regardless of provider.
