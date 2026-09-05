# Installing PropRisk

This is the plug-and-play path: nothing to zero, or zero to a live tenant. It
covers six ways to run the app — pick the one that matches what you're doing.

For the operational deep-dive once something is running (backups, secret
rotation, scaling, upgrades in more detail), see
[`SELF-HOSTING.md`](./SELF-HOSTING.md). For writing rule packs, branding, and
connecting a trading platform, see [`TAILORING.md`](./TAILORING.md). For
day-to-day use of the app once it's live, see
[`USAGE.md`](./USAGE.md). For API and environment-variable reference, see
[`REFERENCE.md`](./REFERENCE.md).

---

## Prerequisites

| Requirement | Needed for |
|---|---|
| Node 20 or newer | Everything. `.nvmrc` at the repo root pins `20`. |
| npm | Everything (ships with Node). |
| git | Cloning the repo (Options A, B, D) or `install.sh`. |
| Docker | Option C (Docker demo) and Option F (self-hosted image). Not needed for A, B, D. |
| Supabase CLI (`supabase`) | Option D (local live development). |
| `psql` | Applying migrations directly against a remote Postgres/Supabase database (an alternative to the Supabase CLI in Option D, and used by `scripts/setup.sh --live --db-url`). |

You do **not** need a database, Docker, or the Supabase CLI to look at the
demo. Options A, B and C get a fully populated mock-data instance running
with nothing but Node (and, for C, Docker).

---

## Option A — one-line install

```bash
curl -fsSL https://raw.githubusercontent.com/vonzelle-vzt/proprisk/main/scripts/install.sh | bash
```

What it does:

1. Checks that `git` is installed.
2. Clones `https://github.com/vonzelle-vzt/proprisk.git` into `./proprisk`
   (refuses to run if that directory already exists and is non-empty).
3. Runs `scripts/setup.sh` inside the clone with demo defaults: installs
   dependencies, creates `.env.local` from the example file, and runs a
   typecheck smoke test.

Then:

```bash
cd proprisk/risk-management
npm run dev
```

Open `http://localhost:3000/risk`.

To install into a specific directory, or pass setup flags straight through:

```bash
curl -fsSL https://raw.githubusercontent.com/vonzelle-vzt/proprisk/main/scripts/install.sh | bash -s -- my-proprisk --live
```

(Anything after the target directory is forwarded to `scripts/setup.sh` — see
Option D and Option E below for what `--live` needs.)

---

## Option B — manual demo (clone + setup script)

If you already have the repo, or don't want to pipe a script into `bash`:

```bash
git clone https://github.com/vonzelle-vzt/proprisk.git
cd proprisk
scripts/setup.sh --demo
cd risk-management
npm run dev
```

`scripts/setup.sh` is idempotent — re-run it any time (after a `git pull`,
say) and it will skip what's already done rather than clobber your
`.env.local`.

### The demo tour

With the dev server running on `http://localhost:3000`:

| Path | What it shows |
|---|---|
| `/risk` | Risk overview — the firm-wide dashboard |
| `/violations` | The violation queue |
| `/rules/demo-apex-futures` | A rule pack in detail: rules, diff, backtest, impact |
| `/a/demo` | The trader-facing view (a trader's own linked page) |

Demo mode (`NEXT_PUBLIC_DEMO_MODE=true`) serves the whole app from mock data:
auth is bypassed, and every data API returns fixtures instead of touching a
database or a live trading-platform API. Nothing you do in the demo persists
or reaches a real backend.

---

## Option C — Docker demo

Two ways to get the same result.

### With Compose

```bash
git clone https://github.com/vonzelle-vzt/proprisk.git
cd proprisk
docker compose up --build proprisk-demo
```

Open `http://localhost:3000/risk`. `docker-compose.yml` at the repo root also
carries a commented-out `proprisk` (live) service template — see Option F.

### With plain `docker build` / `docker run`

```bash
cd proprisk/risk-management
docker build --build-arg NEXT_PUBLIC_DEMO_MODE=true -t proprisk-demo .
docker run -d -p 3000:3000 proprisk-demo
```

There is no Postgres container here on purpose. Live mode needs Supabase
Auth, not just a Postgres server — row-level security policies read the
tenant id out of `request.jwt.claims -> app_metadata`, which only Supabase's
auth/PostgREST layer populates. A plain `postgres:` image gives you tables
with no working isolation. For a real database locally, use the Supabase CLI
(Option D) or a hosted Supabase project.

---

## Option D — local development against a real database

This is for working on live-mode behavior (auth, RLS, real rule-pack
enforcement) without deploying anywhere. It uses the
[Supabase CLI](https://supabase.com/docs/guides/cli), which runs a full local
Supabase stack (Postgres + GoTrue auth + PostgREST) in Docker.

There is no `risk-management/supabase/config.toml` checked into this repo, so
`supabase init` has not been run here yet — you'll generate it locally as
step 1 below; it's gitignored-by-convention for local work and does not need
to be committed for this workflow to work, since only `migrations/` is
shared.

1. **Install the Supabase CLI** (see its docs for your platform — Homebrew,
   npm, or a direct binary all work).

2. **Initialize and start the local stack**, from `risk-management/`:

   ```bash
   cd risk-management
   supabase init      # only if supabase/config.toml doesn't already exist
   supabase start
   ```

   The first run downloads several Docker images and takes a few minutes.
   When it finishes it prints a table of local URLs and keys — keep that
   terminal output, you need it in step 4.

3. **Apply the migrations.** Either let the CLI do it:

   ```bash
   supabase db reset
   ```

   (`db reset` rebuilds the local database from `supabase/migrations/*.sql`
   in order — safe, since this is your local instance.) Or apply them
   directly with `psql` against the local connection string from
   `supabase status`:

   ```bash
   for f in supabase/migrations/*.sql; do
     psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$f"
   done
   ```

   Or let `scripts/setup.sh` do this for you (see below).

4. **Fill in `.env.local`** with the local values `supabase status` printed:

   ```bash
   cd ..   # repo root
   scripts/setup.sh --live --db-url "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
   ```

   This generates `CRON_SECRET`, `PLATFORM_ADMIN_SECRET` and
   `CONNECTIONS_MASTER_KEY` for you, applies the migrations against the URL
   you gave it, sets `NEXT_PUBLIC_DEMO_MODE=false`, and tells you which
   remaining variables to fill by hand. From `supabase status`, copy:

   - `API URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon key` → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role key` → `SUPABASE_SERVICE_ROLE_KEY`

   Set `NEXT_PUBLIC_APP_URL=http://localhost:3000` and
   `SUPPORT_INBOX_EMAIL` to any address you control (it's only used to
   address outbound tickets; with no mail transport configured, tickets are
   drafted and logged instead of sent).

5. **Run it and create the first tenant:**

   ```bash
   cd risk-management
   npm run dev
   ```

   Visit `http://localhost:3000/signup` to create your first tenant and
   account. From there: `/connections` to add a provider connection (or rely
   on the `PROVIDER_*` env fallbacks — see `.env.local.example`), `/rules/new`
   to build a rule pack.

---

## Option E — production on Vercel

1. Import the repository in the Vercel dashboard and set the **root
   directory** to `risk-management`.
2. Add every required environment variable (see
   [`.env.local.example`](../risk-management/.env.local.example) for the
   full annotated list; the non-optional ones are
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `PLATFORM_ADMIN_SECRET`,
   `CONNECTIONS_MASTER_KEY`, `NEXT_PUBLIC_APP_URL`, `SUPPORT_INBOX_EMAIL`,
   and `NEXT_PUBLIC_DEMO_MODE=false`). Mark the secrets as sensitive.
3. Apply the database migrations against your Supabase project first (Option
   D steps 2-3, pointed at the real project, or `scripts/setup.sh --live
   --db-url <your-connection-string>`).
4. Deploy. The build runs `next build`; nothing extra is required.
5. The nine cron schedules in `risk-management/vercel.json` register
   automatically on deploy. **Vercel sends `Authorization: Bearer
   $CRON_SECRET` automatically** on requests it makes to your own Cron Jobs
   when `CRON_SECRET` is set in the project's environment — you do not wire
   this up yourself. Each `/api/cron/*` route checks that header itself
   (`authHeader !== \`Bearer ${process.env.CRON_SECRET}\``); there's no
   separate gate to configure.

---

## Option F — production, self-hosted

For running outside Vercel: your own VM, Kubernetes, Fly.io, Railway,
whatever runs a container.

1. **Build the image with your real `NEXT_PUBLIC_*` values.** These are
   inlined into the client bundle at build time — a container started with
   different environment variables at `docker run` time will *not* pick up a
   different Supabase URL. Rebuild for each real deployment target:

   ```bash
   cd risk-management
   docker build \
     --build-arg NEXT_PUBLIC_DEMO_MODE=false \
     --build-arg NEXT_PUBLIC_SUPABASE_URL=https://yourproject.supabase.co \
     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key \
     --build-arg NEXT_PUBLIC_APP_URL=https://your-domain.example \
     -t proprisk .
   ```

2. **Run it** with the server-only secrets passed at run time (never as
   build args — they don't belong in an image layer):

   ```bash
   docker run -d -p 3000:3000 \
     -e SUPABASE_SERVICE_ROLE_KEY=... \
     -e CRON_SECRET=... \
     -e PLATFORM_ADMIN_SECRET=... \
     -e CONNECTIONS_MASTER_KEY=... \
     -e SUPPORT_INBOX_EMAIL=ops@your-domain.example \
     --name proprisk proprisk
   ```

   Or use `docker-compose.yml`'s commented `proprisk` service, which reads
   the same values from `risk-management/.env.local` via `env_file`.

3. **Put a reverse proxy in front of it** (nginx, Caddy, your platform's
   load balancer) for TLS termination and the public hostname.

4. **Wire up an external scheduler for the nine cron routes** — there is no
   Vercel Cron outside Vercel, so something else has to call these on a
   schedule, each with `Authorization: Bearer $CRON_SECRET`:

   ```cron
   * * * * *     curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-domain.example/api/cron/ingest-trades
   */5 * * * *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-domain.example/api/cron/detect-violations
   * * * * *     curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-domain.example/api/cron/process-violations
   */5 * * * *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-domain.example/api/cron/sample-equity
   */15 * * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-domain.example/api/cron/fraud-hunter
   */15 * * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-domain.example/api/cron/enforce
   30 2 * * 1-6  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-domain.example/api/cron/reviewer
   0 12 * * *    curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-domain.example/api/cron/morning-report
   0 6 * * 1     curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-domain.example/api/cron/sync-news
   ```

   The schedules above match `risk-management/vercel.json` exactly — keep
   them in sync if that file changes.

---

## Post-install checklist

Whichever option you used, before treating an instance as ready:

- [ ] `GET /api/health` returns `200` (demo mode: `{"status":"healthy","demo":true}` unconditionally; live mode: checks env, Supabase, and Redis if configured, and returns `503` if a critical check fails).
- [ ] `/signup` creates a tenant and account (live mode only — demo mode has no signup flow, auth is bypassed entirely).
- [ ] `/connections` can validate a provider connection (or the `PROVIDER_*_ENABLED=true` env fallback works for your firm's platform).
- [ ] A preset can be selected, backtested, and activated end to end (`/rules/new` → backtest → activate).
- [ ] Both isolation checks pass if you touched anything tenant-scoped: `npm run check:isolation` (static) and `supabase/tests/verify-isolation.sh` (live, needs a local Postgres 17 — see `SELF-HOSTING.md`).
- [ ] Every generated secret (`CRON_SECRET`, `PLATFORM_ADMIN_SECRET`, `CONNECTIONS_MASTER_KEY`) is unique to this deployment — never reused from a prior install or from these docs.

---

## Upgrading

```bash
git pull
cd risk-management
npm ci
```

Then apply any new migrations — `supabase/migrations/` only ever appends new
numbered files, it never edits or renumbers an existing one, so re-running
the full chain (via `supabase db push`, or the `for f in .../*.sql` loop) is
safe: already-applied files are idempotent no-ops against a schema that
already has them, and only the new files change anything. Restart the app
(or redeploy, on Vercel) after.

---

## Troubleshooting

**"Node 20+ required" / build fails on an old Node.**
Check `node -v`. Node 18 and earlier are not supported (`engines.node` in
`package.json` requires `>=20`). Install Node 20 (`nvm install 20 && nvm use
20`, or download from nodejs.org).

**Client bundle shows the wrong Supabase project, or demo mode won't turn off
in a Docker image.**
`NEXT_PUBLIC_*` variables are inlined at `next build` time, not read at
container start. Rebuild the image with `--build-arg` set to the values you
want (see Option F step 1) — changing `docker run -e` afterward has no
effect on client-side values.

**`42501: new row violates row-level security policy` (or similar RLS
errors).**
The request reached Postgres without a tenant claim in its JWT
(`request.jwt.claims -> app_metadata`). This usually means you're using the
anon key without a signed-in session, or a session whose `app_metadata` was
never populated with a tenant id — check how the account was created
(`/signup` populates it; a row inserted by hand in the Supabase dashboard
will not).

**Cron routes return `401 Unauthorized`.**
The `Authorization` header didn't match `Bearer $CRON_SECRET` exactly. On
Vercel, confirm `CRON_SECRET` is set in the project's environment (Vercel
injects the header itself once it is). Self-hosted, check your scheduler is
sending `Authorization: Bearer <the same value as CRON_SECRET>` — a trailing
newline or an extra space in a crontab entry is the usual culprit.

**`SUPPORT_INBOX_EMAIL is not set`.**
Required outside demo mode — the support module throws rather than silently
dropping tickets. Set it to any mailbox you control.

**Port already in use (`EADDRINUSE`).**
Something else is on 3000. `npm run dev -- -p 3001`, or for Docker, change
the host side of the port mapping: `docker run -p 3001:3000 ...`.

**`docker build` fails during `npm ci` with a lockfile mismatch.**
`package-lock.json` and `package.json` are out of sync (usually a dependency
added without committing the regenerated lockfile). Run `npm install`
locally, commit the updated lockfile, and rebuild.

**Migrations applied out of order, or partway through.**
Always use `-v ON_ERROR_STOP=1` with `psql` — without it, a failed statement
scrolls past silently and later files apply against a half-built schema. If
you suspect this happened, the safest fix is to rebuild from an empty
database rather than trying to patch forward: migration numbers below
`00015` are pre-tenancy and files after it only append, so replaying the
full chain from scratch is always correct.

**The demo works but a live deployment 404s on the trader link.**
The trader route is `/a/[token]`, not `/a/demo` outside demo mode — `demo` is
a fixed fixture token that only resolves in `NEXT_PUBLIC_DEMO_MODE=true`.
Live tenants issue real per-trader tokens from `/connections` or the accounts
view; use one of those, not `/a/demo`.

---

## See also

- [`SELF-HOSTING.md`](./SELF-HOSTING.md) — operations: backups, secret
  rotation, scaling, more detail on every environment variable.
- [`TAILORING.md`](./TAILORING.md) — writing rule packs, branding the app,
  connecting a trading platform, the staged-launch gate.
- [`USAGE.md`](./USAGE.md) — day-to-day use once a tenant is live.
- [`REFERENCE.md`](./REFERENCE.md) — API and configuration reference.
