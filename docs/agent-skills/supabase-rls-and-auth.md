# Skill: Supabase RLS and auth

**Use when:** writing or reviewing a Supabase migration, a route handler that
touches auth, a new policy, or any code that reads a user's role or tenant.
Pairs with [tenant-isolation](./tenant-isolation.md) — that skill covers the
five-layer model; this one covers the Supabase-specific mechanics each layer
depends on.

## `app_metadata` vs `user_metadata`

Read role and tenant from `app_metadata` only. `risk-management/src/lib/auth/guards.ts`:

```ts
const { data, error } = await supabase.auth.getUser();
// ...
const rawRole = data.user.app_metadata?.role;
const rawTenant = data.user.app_metadata?.tenant_id;
```

`user_metadata` is writable by the signed-in user via
`supabase.auth.updateUser()`. Authorization read from it is a
privilege-escalation path — a user sets their own `role: "admin"` and the
app believes it. This was a real defect in this codebase (`guards.ts` had a
fallback to `user_metadata`), which is why `check-isolation.mjs` checks for
it permanently rather than relying on review to catch it again. `app_metadata`
is set server-side only (service role, at sign-in and invite acceptance from
`tenant_members`), so it cannot be forged by the client.

## `auth.getUser()`, never `auth.getSession()`, for authorization

`getUser()` re-validates the JWT against Supabase's auth server on every
call. `getSession()` reads the session from local storage / cookies without
re-validating it — a session that Supabase has since revoked (a banned user,
a rotated key) still passes a `getSession()` check. Use `getSession()` only
where you already trust the caller and just need convenience data (e.g.
displaying a cached name); never for an authorization decision.

## FORCE RLS, not just ENABLE

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE  ROW LEVEL SECURITY;
```

`ENABLE` alone does not apply RLS to the table owner, and every migration
runs as the owner. Without `FORCE`, a policy that looks airtight in the SQL
file does nothing the moment anyone runs a query as that role. Every
tenant-scoped table in this repo carries both.

## Per-operation policies, with `WITH CHECK` on writes

Four separate policies, not one blanket one:

```sql
CREATE POLICY tenant_select_x ON x FOR SELECT TO authenticated
  USING (tenant_id = auth_tenant_id());
CREATE POLICY tenant_insert_x ON x FOR INSERT TO authenticated
  WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_update_x ON x FOR UPDATE TO authenticated
  USING (tenant_id = auth_tenant_id()) WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_delete_x ON x FOR DELETE TO authenticated
  USING (tenant_id = auth_tenant_id());
```

`USING` constrains which existing rows a statement can see or touch.
`WITH CHECK` constrains what the *resulting* row is allowed to look like. A
`WITH CHECK` on UPDATE is what stops a row being moved *into* another
tenant — a `USING`-only policy on UPDATE would let an authenticated user
change their own row's `tenant_id` to someone else's, since the check only
ever looks at the row before the write. INSERT only ever needs `WITH CHECK`
(there is no existing row to constrain with `USING`).

Add a fifth, `service_role` policy (`USING (true) WITH CHECK (true)`) for
the tenant-scoped server path — background jobs authenticate as the service
role and rely on `tenantDb()`, not RLS, to stay scoped (see
[tenant-isolation](./tenant-isolation.md) layer 4).

## `SECURITY INVOKER` helper functions, and fail-closed on NULL

```sql
CREATE FUNCTION auth_tenant_id() RETURNS uuid
LANGUAGE sql SECURITY INVOKER STABLE AS $$
  SELECT (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid;
$$;
```

`SECURITY INVOKER` (the default, but state it explicitly) means the function
runs with the *calling* role's privileges, not the definer's — a
`SECURITY DEFINER` helper used inside an RLS policy can silently reintroduce
the bypass RLS exists to prevent. `auth_tenant_id()` returns NULL for a
claimless token, and `tenant_id = NULL` evaluates to NULL (not TRUE) in
Postgres, so every policy above refuses by default rather than admitting
everything. Verify this empirically (`verify-isolation.sh` asserts it) —
never assume NULL-safety without a test proving it.

## Never `createAdminClient()` in a route

`risk-management/src/lib/supabase/admin.ts` wraps the service-role key,
which holds `BYPASSRLS`. A route handler under `src/app/api/**` calling it
directly turns off every policy above for that request. `check-isolation.mjs`
fails the build on this outside an explicit, justified allowlist. If a route
genuinely needs elevated access (a webhook with its own signature
verification, say), the exception belongs on that allowlist with a comment
naming the reason — not a silent import.

## Request-scoped client vs `tenantDb()`

- **Routes** (anything with an end-user session): use
  `createClient()` (`src/lib/supabase/server.ts`), which reads the caller's
  own cookies via `@supabase/ssr`. RLS constrains every query this client
  makes — the tenant claim isn't a filter the route applies, it's a
  predicate the database enforces.
- **Background work** (crons, ingestion, the reviewer, anything with no
  session): use `tenantDb(tenantId, 'label')`
  (`src/lib/db/tenant-scoped.ts`). It runs under the service role — RLS is
  not the safety net there — but it cannot be constructed without naming a
  tenant, and it pre-filters reads and stamps writes with that tenant. This
  is layer 4 of [tenant-isolation](./tenant-isolation.md).

Never use `tenantDb()` inside a route that has a real session (you'd be
throwing away RLS for no reason), and never reach for the request-scoped
client inside a cron (there is no session for it to scope to).

## Verification

```bash
cd risk-management && npm run check:isolation
bash supabase/tests/verify-isolation.sh   # needs local Postgres 17 on :55432
```

See [tenant-isolation](./tenant-isolation.md) for what each one actually
checks and what fails CI.

## Common mistakes

- Falling back to `user_metadata` "just for this one field" — there is no
  safe partial exception; any authorization-relevant field must come from
  `app_metadata`.
- Writing a policy with only `USING` on an UPDATE-capable table.
- Enabling RLS without forcing it, then being confused when a migration
  (running as owner) appears to bypass a policy that looks correct.
- Calling `getSession()` in a route guard because it's synchronous/cached —
  it skips revocation checks that `getUser()` performs.
- A `SECURITY DEFINER` helper invoked from inside a policy, which
  reintroduces a privilege escalation the policy was trying to prevent.
