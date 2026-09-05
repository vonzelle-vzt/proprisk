# Self-hosting PropRisk

Running the platform yourself, end to end: database, environment, deployment,
secrets, backups and upgrades.

If you only want to look at it, you do not need any of this — set
`NEXT_PUBLIC_DEMO_MODE=true` and run `npm run dev`. See the
[Quick start](../README.md#quick-start--the-demo-in-five-minutes).

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| Node 20 or newer | `.nvmrc` at the repo root reads `20`; CI pins the same version explicitly |
| A Supabase project | Postgres plus auth. A self-managed Postgres 15+ works if you provide the `auth` schema helpers and the `anon` / `authenticated` / `service_role` roles |
| A host that runs Node | Vercel, or anything that can serve a Next.js production build |
| A scheduler | Vercel Cron, or any scheduler that can send an authenticated HTTP GET |
| `psql` or the Supabase CLI | To apply migrations |
| Postgres 17 locally | Only to run the SQL isolation suite. Optional but recommended before any release |

Optional: Upstash Redis (rate limits and per-tenant queue namespaces), Stripe
(billing), Resend or a Gmail app password (outbound mail), an Anthropic API key
(narrative polish and chat intent — never decisions).

The application runs with **only** Supabase configured. Everything else degrades:
no Redis means an in-memory rate limiter, no Stripe means no billing routes, no
mail transport means notices are drafted and logged rather than sent.

---

## 2. Supabase setup

### 2.1 Create the project

Create a project, then collect three values from its API settings: the project
URL, the `anon` key, and the `service_role` key. The service-role key holds
`BYPASSRLS` — treat it like a database password, never expose it to a browser,
and never put it in a `NEXT_PUBLIC_*` variable.

### 2.2 Apply the migrations, in order

`risk-management/supabase/migrations/` is applied in filename order. `00001` is
the consolidated baseline schema; tenancy and row-level security arrive in
`00015`; the numbers `00002`–`00014` are deliberately unused, because the
original chain was consolidated. Everything after `00015` only appends.

With the Supabase CLI:

```bash
cd risk-management
supabase link --project-ref <your-project-ref>
supabase db push
```

Or directly with `psql`:

```bash
cd risk-management
for f in supabase/migrations/*.sql; do
  echo "== $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

`ON_ERROR_STOP=1` matters. Without it a failed migration scrolls past and the
next one applies against a half-built schema.

### 2.3 Confirm isolation actually holds

Do not skip this. It is the difference between believing the model and knowing
it.

```bash
# Needs a local Postgres 17 listening on port 55432. It drops and rebuilds its
# own database from the full migration chain, then acts as the `authenticated`
# role with live JWT claims.
bash risk-management/supabase/tests/verify-isolation.sh
```

It asserts that firm A sees only its own rows; gets nothing when it names firm
B's tenant id explicitly; cannot insert into firm B or move its own row there;
affects zero rows with a cross-tenant delete; and that a token carrying no tenant
claim sees nothing at all. It also checks that every tenant-scoped table has
`tenant_id`, forced RLS and five policies, with no unconstrained policy left for
`authenticated`.

The static guard answers the other question — will it still hold tomorrow:

```bash
node risk-management/scripts/check-isolation.mjs
```

Expected: `Isolation guard: clean`. Run it in CI; it already is in
`.github/workflows/ci.yml`.

---

## 3. Environment variables

Every variable is annotated in
[`../risk-management/.env.local.example`](../risk-management/.env.local.example).
Copy it to `.env.local` for local work; set the same names in your host's
environment for a deployment. **Never commit a `.env` file** — `.gitignore`
covers them and the release gate refuses to export a tree where one is tracked.

### 3.1 Required

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key. This one is meant to be public; RLS is what protects the data behind it |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role. Server-side only, holds `BYPASSRLS` |
| `CRON_SECRET` | Bearer token every `/api/cron/*` route requires. Generate with `openssl rand -hex 32` |
| `NEXT_PUBLIC_APP_URL` | Your origin. CORS headers are emitted **only** for this origin; unset means no CORS rather than `*` |

### 3.2 Required for real (non-demo) operation

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_DEMO_MODE` | Set to `false`. When `true` the app is public and every API returns mock data |
| `CONNECTIONS_MASTER_KEY` | Master key for per-tenant credential encryption. `openssl rand -base64 32`; must decode to exactly 32 bytes (hex or base64 both accepted) |
| `PLATFORM_ADMIN_SECRET` | Bearer token for `/api/platform-admin/*`. **Must differ from `CRON_SECRET`** — those routes act across tenants, and leaking one must not grant the other |
| `SUPPORT_INBOX_EMAIL` | Where support tickets go. The support module throws outside demo mode if unset, rather than dropping tickets silently |

### 3.3 Optional — infrastructure

| Variable | Effect if unset |
|---|---|
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Rate limiting falls back to in-memory, which is per-instance and therefore weaker under horizontal scaling |
| `RESEND_API_KEY` | Falls back to Gmail if `GMAIL_USER` and `GMAIL_APP_PASSWORD` are set; otherwise notices are drafted and logged, not sent |
| `BRAND_EMAIL_FROM`, `BRAND_EMAIL_SENDER_NAME` | Sender defaults |
| `BILLING_ENABLED` | Optional, default `false`. Set to `true` only if you're running this as a hosted service for other firms; the three `/api/billing/*` routes 404 while it's off, and no Stripe variable is read |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_SCALE` | Needed only when `BILLING_ENABLED=true`. Billing routes are inert (404) otherwise |
| `ANTHROPIC_API_KEY` | Chat and narrative polish are disabled. No decision path depends on this |
| `RISK_WEBHOOK_URL`, `RISK_SLACK_WEBHOOK_URL` | Breach notifications are not fanned out |
| `ENFORCEMENT_AGENT_ENABLED`, `REVIEWER_AGENT_ENABLED` | Those agents stay off |

### 3.4 Optional — branding

`NEXT_PUBLIC_BRAND_NAME`, `_COMPANY`, `_TAGLINE`, `_LOGO_URL`, `_FAVICON_URL`,
`_ACCENT`, `_NEUTRAL`. See [`TAILORING.md` §3](./TAILORING.md#3-brand-the-app).

### 3.5 Optional — trading platforms

Per-provider environment fallbacks follow one convention:

```
PROVIDER_<ID>_ENABLED=true
PROVIDER_<ID>_API_URL=...
PROVIDER_<ID>_API_KEY=...
PROVIDER_<ID>_<ANYTHING_ELSE>=...     # collected into the adapter's `extra` bag
```

`<ID>` is one of `matchtrader`, `dxtrade`, `tradelocker`, `ctrader`,
`metatrader`, `tradovate`, `rithmic`, `topstepx`, `cqg`, `ninjatrader`.

These are a **fallback**. Tenants normally supply their own credentials through
`/connections`, which stores them envelope-encrypted per tenant; the environment
path exists so a single-firm deployment can skip that page, and so a freshly
onboarded tenant is not hard-broken before filling it in.

MatchTrader additionally reads `PROVIDER_MATCHTRADER_SYSTEM_UUID` and
`PROVIDER_MATCHTRADER_GROUPS`; Tradovate reads `PROVIDER_TRADOVATE_ENV`,
`_NAME`, `_PASSWORD`, `_APP_ID`, `_APP_VERSION`, `_CID`, `_SEC`, `_DEVICE_ID`.

---

## 4. Deploying to Vercel

1. Import the repository and set the **root directory** to `risk-management`.
2. Add every variable from §3. Mark the secrets as sensitive.
3. Deploy. The build runs `next build`; nothing else is required.
4. The nine cron schedules in `risk-management/vercel.json` are registered
   automatically:

```json
{
  "crons": [
    { "path": "/api/cron/ingest-trades",     "schedule": "* * * * *" },
    { "path": "/api/cron/detect-violations", "schedule": "*/5 * * * *" },
    { "path": "/api/cron/process-violations","schedule": "* * * * *" },
    { "path": "/api/cron/sample-equity",     "schedule": "*/5 * * * *" },
    { "path": "/api/cron/fraud-hunter",      "schedule": "*/15 * * * *" },
    { "path": "/api/cron/enforce",           "schedule": "*/15 * * * *" },
    { "path": "/api/cron/reviewer",          "schedule": "30 2 * * 1-6" },
    { "path": "/api/cron/morning-report",    "schedule": "0 12 * * *" },
    { "path": "/api/cron/sync-news",         "schedule": "0 6 * * 1" }
  ]
}
```

Cron routes require `Authorization: Bearer $CRON_SECRET`, checked in middleware
**and** again in the handler, and enforced even in demo mode. Set `CRON_SECRET`
in the project's environment so the platform's scheduler presents it.

---

## 5. Deploying anywhere else

```bash
cd risk-management
npm ci
npm run build
npm start            # defaults to port 3000; PORT is honoured
```

Put it behind a TLS-terminating reverse proxy and point an external scheduler at
the cron routes. Any scheduler works — cron, systemd timers, a Kubernetes
CronJob, a queue worker:

```bash
# /etc/cron.d/proprisk  — the same nine schedules as vercel.json
* * * * *    proprisk curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-host/api/cron/ingest-trades      > /dev/null
*/5 * * * *  proprisk curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-host/api/cron/detect-violations > /dev/null
* * * * *    proprisk curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-host/api/cron/process-violations> /dev/null
*/5 * * * *  proprisk curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-host/api/cron/sample-equity     > /dev/null
*/15 * * * * proprisk curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-host/api/cron/fraud-hunter      > /dev/null
*/15 * * * * proprisk curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-host/api/cron/enforce           > /dev/null
30 2 * * 1-6 proprisk curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-host/api/cron/reviewer          > /dev/null
0 12 * * *   proprisk curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-host/api/cron/morning-report    > /dev/null
0 6 * * 1    proprisk curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-host/api/cron/sync-news         > /dev/null
```

Use `-f` so a non-2xx response is a non-zero exit your scheduler can alert on. A
cron that fails silently for a week is exactly the failure mode this product
exists to eliminate elsewhere; do not reintroduce it in your own operations.

**Timeouts.** `detect-violations` declares a 300-second maximum duration and fans
out across tenants at concurrency 3. If your host imposes a shorter limit, lower
the concurrency or shard the fan-out; do not raise the concurrency to finish
faster, because that is what lets one large firm starve the others.

---

## 6. The platform-admin secret

`/api/platform-admin/*` acts **across** tenants — it is how a platform operator
signs off a firm's rule pack before that firm's rules may enforce. No customer
session can authorise it, so it is gated on `PLATFORM_ADMIN_SECRET`, checked in
middleware before the demo-mode bypass so a demo deployment can never expose it.

```bash
openssl rand -hex 32     # generate; keep it separate from CRON_SECRET
```

If you run PropRisk for a single firm — your own — you do not need this workflow.
Clear the gate for your tenant:

```sql
UPDATE tenants SET enforcement_approval_required = false WHERE id = '<your-tenant-id>';
```

Set `PLATFORM_ADMIN_SECRET` anyway, to something random. An unset secret means
the middleware refuses every request to those routes, which is the correct
failure, but a random value costs nothing and avoids confusion later.

---

## 7. Rotating secrets

| Secret | How to rotate |
|---|---|
| `CRON_SECRET` | Set the new value, update the scheduler, redeploy. A brief window of 401s is the worst case |
| `PLATFORM_ADMIN_SECRET` | Same. Nothing persists it |
| `SUPABASE_SERVICE_ROLE_KEY` | Rotate in Supabase, update the environment, redeploy |
| `CONNECTIONS_MASTER_KEY` | **Not** a drop-in swap — every stored credential is encrypted under a key derived from it |

To rotate the master key: mint the new key, bump `CURRENT_KEY_VERSION` in
`src/lib/crypto/envelope.ts`, and re-encrypt each `connections` row by decrypting
under the old version and writing back under the new one. The key version travels
inside the ciphertext (`<keyVersion>.<iv>.<authTag>.<ciphertext>`), so old blobs
stay readable throughout the window rather than the whole vault going dark the
moment you change the variable. Keep the old master key available until every row
has moved.

Provider credentials themselves rotate through `/connections` — update, then
press **Validate**, which performs a real read and records the result.

---

## 8. Backups

- **Enable point-in-time recovery** on the Supabase project. The `audit_log` is
  the artifact that lets a firm defend a two-year-old termination; losing it is
  worse than losing the application.
- **`CONNECTIONS_MASTER_KEY` is not in the database and is not in your backup.**
  A restore without it leaves every stored provider credential undecryptable.
  Keep it in a secrets manager with its own retention, and test that you can
  actually retrieve it.
- The audit chain is tamper-**evident**, not tamper-proof: it tells you a row was
  altered, it does not prevent it. Restrict write access to the database
  accordingly.

---

## 9. Upgrading

New migrations only append; none rewrites an applied file. So:

```bash
git pull
cd risk-management && npm ci
supabase db push                      # or psql the new files only
npm run build

# then re-run the gates
node scripts/check-isolation.mjs
npx vitest run
```

After an upgrade that touches anything tenant-scoped, run the SQL isolation suite
as well (§2.3). The static guard catches the four historical erosion patterns;
the SQL suite catches the ones nobody has thought of yet.

Never edit a migration that has been applied anywhere. If a migration was wrong,
add another that corrects it — an edited migration produces two databases that
disagree while both claiming to be at the same version.

---

## 10. Health and monitoring

```bash
curl -s https://your-host/api/health | jq
```

Reports environment validation (which required variables are missing), a
Supabase round-trip with latency, and Redis with latency or `skip` when it is not
configured. It reads no tenant data, so it is safe to expose and safe to poll.

Watch three things in your logs, all of which are structured JSON:

1. **Per-tenant cron outcomes.** Every job returns one outcome per tenant with
   `ok`, and a failed tenant is reported rather than aborting the batch. A tenant
   that is `ok: false` every run is a broken connection, not a blip.
2. **`skipped` rules.** A rule that cannot be evaluated is not a breach and is
   not a pass. If `drawdown` is skipped for want of equity snapshots, your main
   rule is not being enforced — see
   [`TAILORING.md` §4](./TAILORING.md#4-connect-your-trading-platform).
3. **Jobs that report success while doing nothing.** Counts of zero across the
   board on a day the firm traded is a signal, not silence. Every job here
   reports what it persisted for exactly this reason.
