# Security policy

## Supported versions

Only `main` is supported. There are no maintained release branches; if you are
running an older commit, update before reporting an issue that a later commit
may already fix.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository: go to the
**Security** tab → **Report a vulnerability**. Do not open a public issue for
a security problem.

You should get an acknowledgement within 3 business days. For high or
critical severity issues we target a fix within 30 days; lower-severity
issues are handled on a best-effort basis and the timeline will depend on
what else is in flight.

## What's in scope

- Cross-tenant data access of any kind (a firm seeing, modifying, or deleting
  another firm's rows, accounts, or evidence).
- Authentication or authorization bypass, including privilege escalation via
  a mutable claim (e.g. `user_metadata` instead of `app_metadata`).
- Row-level security or policy gaps — a table missing `tenant_id`, a
  permissive policy, a policy that isn't `FORCE`d.
- Secret exposure — committed credentials, secrets echoed in logs or error
  responses, or a secret reachable from a route that shouldn't have it.
- SSRF via configurable provider URLs (`PROVIDER_*_API_URL`, `TRADING_API_URL`,
  webhook targets).
- Webhook signature bypass (Stripe, or any inbound webhook the app verifies).
- Cron or platform-admin secret misuse — anything that lets `CRON_SECRET` or
  `PLATFORM_ADMIN_SECRET` be reused outside its intended route, or that lets
  one substitute for the other.

## What to test

This platform's core security property is tenant isolation, enforced across
five layers described in
[`risk-management/docs/ISOLATION.md`](risk-management/docs/ISOLATION.md):
the `app_metadata` tenant claim, row-level security with `WITH CHECK` on every
tenant table, request-scoped database access, the `tenantDb()` scoped
data-access layer for background work, and runtime partitioning (provider
token caches, Redis keyspaces, cross-account scans, unique constraints).

Two commands exercise those layers directly, and are the fastest way to check
whether a change (or a reported issue) actually breaks isolation:

```
node scripts/check-isolation.mjs
bash supabase/tests/verify-isolation.sh
```

The first is a static guard (new tables, banned patterns, `user_metadata`
reads). The second builds a real Postgres instance and asserts isolation
against live JWT claims, including that a cross-tenant `INSERT`, row-move
`UPDATE`, and cross-tenant `DELETE` all fail. Read the doc before assuming a
finding is novel — it lists what is already covered.

## Out of scope

- Demo mode (`NEXT_PUBLIC_DEMO_MODE=true`). It is public by design: auth is
  bypassed and every API returns mock data. Findings that only reproduce
  against a demo deployment are not a vulnerability unless they show a way to
  reach real data or a real provider from that mode.
- Stub provider adapters (any adapter whose live block is not yet
  implemented — see `risk-management/src/lib/providers/adapters/`).
- Rate limiting on the demo deployment.

## Secret handling for operators

- Never commit `.env*` files. `.env.local.example` is the only committed
  template and it must never contain a real value.
- Rotate `CRON_SECRET`, `PLATFORM_ADMIN_SECRET`, `CONNECTIONS_MASTER_KEY`, and
  the Supabase service-role key immediately on any suspected exposure —
  including a leaked log line, a shared screenshot, or a compromised CI
  environment.
- Keep `PLATFORM_ADMIN_SECRET` distinct from `CRON_SECRET`. They authorize
  different things (cross-tenant platform-admin routes vs. scheduled jobs)
  and must not be interchangeable — leaking one must not grant the other.

## Disclosure

We do not currently run a bug bounty. We ask for coordinated disclosure:
please give us the acknowledgement and fix-target windows above before any
public write-up, and we'll credit reporters in the fix commit or release
notes unless you ask us not to.
