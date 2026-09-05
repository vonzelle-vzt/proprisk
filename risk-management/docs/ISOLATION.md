# Tenant isolation

No prop firm can see another firm's data. That is a product promise, not a best
effort, so this document describes how it is enforced and — more importantly —
how to keep it true while the codebase keeps changing.

## Why five layers

Any single mechanism here can be defeated by one ordinary mistake:

- RLS is defeated by a route using the service-role client.
- The service-role wrapper is defeated by importing `createAdminClient` directly.
- A `tenant_id` column is defeated by a query that forgets to filter on it.
- A JWT claim is defeated by reading the role from user-editable metadata.

None of those are exotic. Each is the kind of thing a competent engineer does on
a Friday afternoon while fixing something else. So isolation is enforced five
times over, and a CI guard fails the build when a change removes one of them.

## Layer 1 — the tenant claim

Every session carries `tenant_id` and `role` in Supabase **`app_metadata`**,
minted server-side from `tenant_members` at sign-in and invite acceptance.

Never `user_metadata`. That field is writable by the user through
`supabase.auth.updateUser()`, so authorization read from it lets any signed-in
user promote themselves to admin. This was a real defect in this codebase
(`guards.ts` fell back to it), which is why the CI guard now checks for it
permanently.

`src/lib/auth/guards.ts` refuses a session that has a valid role but no tenant.
A tenantless session is unusable, not global.

## Layer 2 — row-level security

`supabase/migrations/00015_tenancy.sql` puts `tenant_id NOT NULL` on every
tenant-scoped table and gives each four per-operation policies:

```sql
USING (tenant_id = auth_tenant_id())            -- SELECT, UPDATE, DELETE
WITH CHECK (tenant_id = auth_tenant_id())       -- INSERT, UPDATE
```

`WITH CHECK` on UPDATE is what stops a row being *moved* into another tenant; a
`USING`-only policy would allow it.

`auth_tenant_id()` is `SECURITY INVOKER` and returns NULL when the JWT has no
tenant claim. `tenant_id = NULL` evaluates to NULL — not TRUE — so every policy
**fails closed**: a claimless token sees nothing rather than everything.

Policies are generated in a loop from one canonical table list rather than
written out 88 times. A hand-written list of 88 policies is a list with a typo
in it, and a typo here is a data leak.

## Layer 3 — request-scoped database access

Route handlers reach the database as the signed-in user (anon key + their
cookies, `src/lib/supabase/server.ts`), so RLS constrains them.

`createAdminClient()` uses the **service role**, which holds `BYPASSRLS`. A route
handler calling it directly is a route where every policy above is switched off.
The CI guard rejects this outside an explicit, justified allowlist.

## Layer 4 — the scoped data-access layer

Background work — crons, ingestion, the reviewer — has no session, so it must
use the service role. For that code path RLS is not a safety net, and the
failure mode is not malice: it is a future `.from('accounts').select('*')`
written by someone who forgot, which under the service role silently returns
every firm's data and looks like it works.

`src/lib/db/tenant-scoped.ts` removes that possibility. You cannot obtain a
query builder without naming a tenant:

```ts
const db = tenantDb(tenantId, 'detect-violations cron');
await db.from('accounts');            // pre-filtered
await db.insert('violations', row);   // stamped
```

- Reads are pre-filtered by `tenant_id`.
- Inserts and upserts are **stamped**, overriding any `tenant_id` in the
  payload, so a mistaken or reflected value cannot redirect a write.
- Updates **discard** `tenant_id` from the patch rather than re-stamping it,
  because permitting `SET tenant_id = ...` would move a row across the boundary.
- Genuinely global reference data is reachable only via `globalTable()`, so
  crossing the boundary is a named, greppable act rather than an omission.
- `listActiveTenantIds()` is the single sanctioned way to iterate tenants. Cron
  jobs fan out with it and then work inside `tenantDb(id)` per tenant.

## Layer 5 — runtime partitioning

Isolation is not only a database concern:

- **Provider token caches.** `tradovate.ts` and `matchtrader.ts` held session
  tokens in module-scoped variables. Shared, the first firm to authenticate
  populates the module and every later firm's requests use that firm's token.
  Both are now `Map`s keyed by tenant.
- **Redis keyspace.** Queue keys are namespaced per tenant; one global key means
  one firm's jobs can be drained by another's worker.
- **Cross-account scans.** Copy-trading and grid ring detection compare every
  account against every other. Unpartitioned, that surfaces one firm's trading
  patterns inside another firm's alerts — a leak that never touches a row the
  reader was not allowed to read.
- **Unique constraints.** Several were keyed on provider-issued identifiers
  (`accounts.login`, `platform_payout_id`, snapshot and fraud dedupe keys). Two
  firms routinely hold the same value, so globally-unique constraints made the
  second firm to onboard an account numbered 1001 fail on insert. All are now
  scoped by `tenant_id`.

## Verifying it

Two checks, and they answer different questions.

**`supabase/tests/verify-isolation.sh`** — does isolation actually hold?

Builds a real Postgres from the baseline plus migrations, then acts as the
`authenticated` role with live JWT claims and asserts that Firm A:

- sees only its own rows;
- gets nothing when it names Firm B's tenant id explicitly;
- cannot INSERT into Firm B, or move its own row there;
- affects 0 rows with a cross-tenant DELETE;
- sees nothing at all with a token carrying no tenant claim.

Plus: every tenant-scoped table has `tenant_id`, forced RLS and five policies,
and no unconstrained or non-tenant-scoped policy remains for `authenticated`.

Needs a local Postgres 17 on port 55432. It drops and rebuilds its own database.

**`node scripts/check-isolation.mjs`** — will isolation still hold tomorrow?

Fails the build on: a new table without `tenant_id`; a `USING (true)` policy for
`authenticated`; a route handler calling `createAdminClient()`; a read of role or
tenant from `user_metadata`. Run it in CI.

It skips migrations before `00015`, because that migration drops and recreates
every policy on every tenant table — a permissive policy in an older file
describes a state that no longer exists, and 21 permanent false positives would
train everyone to ignore the script.

## Adding a table

1. `tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`.
2. Copy the RLS block from `00015` verbatim — four authenticated policies plus
   the `service_role` policy, with `ENABLE` **and** `FORCE ROW LEVEL SECURITY`.
   Forcing matters: the table owner bypasses RLS otherwise, and migrations run
   as owner.
3. Lead every index with `tenant_id`.
4. Scope any UNIQUE constraint that is keyed on a value the provider issues.
5. Run both checks above.

If the table is genuinely global, add it to `GLOBAL_TABLES` in **both**
`scripts/check-isolation.mjs` and `src/lib/db/tenant-scoped.ts`, with the reason.
Making something global should be a decision someone signed.
