# Database

The schema is one ordered chain of SQL files in `migrations/`. There is no
baseline file to apply separately and no per-customer variant to keep in sync:
what a fresh install runs is what production ran.

## Applying to a fresh project

Apply every file in `migrations/` in sorted filename order, in one pass, against
an empty database:

```bash
for f in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

`ON_ERROR_STOP=1` is not optional. Without it psql reports success after a
failed statement, and you get a half-built schema that looks fine until the
first query against the missing table.

The chain expects the roles and helpers a Supabase project already provides —
the `anon` / `authenticated` / `service_role` roles, `auth.uid()`, `auth.jwt()`,
and default privileges granting `authenticated` table access at creation time.
On a plain Postgres you must create them first; `tests/verify-isolation.sh`
contains the exact preamble it uses to do that, and is the reference.

## Numbering

- Files are `NNNNN_snake_case_name.sql`, five digits, applied in sorted order.
- **Numbers are unique.** Two files sharing a number make the order ambiguous,
  and the two orders build different schemas.
- **00001 is the consolidated pre-tenancy schema.** It is every table, enum,
  index, function and trigger the platform had before multi-tenancy, flattened
  into one file.
- **00002-00014 are permanently unused.** The migrations that held those numbers
  were folded into 00001. The gap is deliberate: it lets `00015_tenancy.sql`
  keep the number it has always had, which the guard script, the isolation test
  and the docs all name directly. Do not backfill the gap.
- **Tenancy and RLS begin at 00015.** Everything before it is pre-tenancy and
  not safe on its own; 00015 adds `tenant_id` to every table 00001 creates,
  rewrites every policy with a tenant predicate, and forces RLS.
- New work continues from the highest number present. Never renumber or edit a
  migration that has been applied anywhere — write a new one.

## Both isolation checks must pass

Tenant isolation is a product promise, so it is checked two ways, and neither
one substitutes for the other. Run both before shipping any schema change.

```bash
npm run check:isolation              # static: reads the SQL and the routes
zsh supabase/tests/verify-isolation.sh   # empirical: builds a real DB and attacks it
```

- `scripts/check-isolation.mjs` reads source. It catches a table added without
  `tenant_id`, a policy written `USING (true)`, a route reaching for the
  service-role client, and a guard reading a role out of user-editable
  `user_metadata`. It cannot tell you whether the schema those files build
  actually holds.

- `supabase/tests/verify-isolation.sh` builds the schema on a real Postgres 17
  (local, port 55432) from the whole chain and then tries to break out of it:
  cross-tenant `SELECT`, `INSERT`, `UPDATE` and `DELETE`, a token carrying no
  tenant claim, and a firm's own owner trying to rewrite its plan tier, status,
  account ceiling or enforcement gate. It also asserts that every tenant-scoped
  table has forced RLS and policies that name `tenant_id`. It cannot tell you
  about code paths that never reach the database.

The static check passing while the empirical one fails means the SQL does not
build the schema you think it does. The reverse means something outside the
database — a route, a guard — is bypassing a schema that is itself sound.
