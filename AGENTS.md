# AGENTS.md

PropRisk — an open-source risk desk for prop trading firms: versioned rule packs,
hard multi-tenant isolation, evidence-backed breach decisions, PDF/CSV violation
reports. The Next.js 14 application lives in `risk-management/`.

## Read before changing anything

- [`docs/BUILD-SPEC.md`](./docs/BUILD-SPEC.md) — invariants (§1.2 is the part you
  cannot violate), data model, rule-pack and provider contracts.
- [`DESIGN.md`](./DESIGN.md) — the visual contract, before any UI work.
- [`risk-management/docs/ISOLATION.md`](./risk-management/docs/ISOLATION.md) —
  the five isolation layers, and how each is verified.
- [`docs/INSTALL.md`](./docs/INSTALL.md) and [`docs/USAGE.md`](./docs/USAGE.md)
  — how to run the app, and how to use it once it's running.

## Skills

- [`docs/agent-skills/`](./docs/agent-skills/) — loadable instruction sets:
  tenant isolation, Supabase RLS/auth, rule-pack authoring, the
  violation-report contract, and the verification gate.
- Load the relevant skill before touching that area; load
  `verification-before-done.md` before reporting any change finished.

## Conventions

- TypeScript `strict`; zod on every route body; server components by default.
- **Routes** use the request-scoped Supabase client, so RLS constrains them;
  **jobs** use `tenantDb(tenantId)`, which cannot build a query without a tenant.
  Never call `createAdminClient()` in a route.
- Read role and tenant from `app_metadata`, never `user_metadata` — that field is
  user-editable, so authorization read from it is a privilege-escalation path.
- In a rule pack `enabled: false` and absent mean the same thing — the rule does
  not exist for that firm, which is not a generous threshold.
- A rule that could not be evaluated is `skipped`, with a reason — never a pass,
  a zero, or an empty state. Every job reports what it **persisted**, not what it
  attempted. A model may describe a decision, never make one.

## Commands

```bash
cd risk-management && npm run dev|build|lint|typecheck|test|check:isolation
node ../scripts/release/check-doc-links.mjs   # every relative link resolves
bash ../scripts/release/check-banned-terms.sh # nothing private ships
```

**After touching anything tenant-scoped run both isolation checks:**
`risk-management/scripts/check-isolation.mjs` (will it hold tomorrow) and
`risk-management/supabase/tests/verify-isolation.sh` (does it hold — needs
Postgres 17 on :55432). Never commit `.env*`, never name a customer. PRs: [`CONTRIBUTING.md`](./CONTRIBUTING.md).
