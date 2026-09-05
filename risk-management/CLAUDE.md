# CLAUDE.md — the application

The Next.js 14 app. Repo-wide conventions and the invariants you must not violate
are in [`../AGENTS.md`](../AGENTS.md) and
[`../docs/BUILD-SPEC.md`](../docs/BUILD-SPEC.md) §1.2. Read those first.

Local pointers:

- [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) — the four flows and the
  reasoning behind them.
- [`docs/ISOLATION.md`](docs/ISOLATION.md) — the five isolation layers. Read it
  before touching `src/lib/db/`, `src/lib/auth/`, or any migration.
- [`../DESIGN.md`](../DESIGN.md) — the visual contract, before any UI work.
- [`../docs/REFERENCE.md`](../docs/REFERENCE.md) — every page, route and table.
- [`../docs/agent-skills/`](../docs/agent-skills/) — load the matching skill
  (tenant isolation, Supabase RLS/auth, rule-pack authoring, the
  violation-report contract, verification-before-done) before you start.
- `src/lib/rulepack/` — the engine. Pure and deterministic; keep it that way.
- `src/lib/providers/` — ten adapters, two live. A stub throws rather than
  returning an empty list, because an empty list reads as "no breaches".

```bash
npm run dev | build | lint | typecheck | test | check:isolation
bash supabase/tests/verify-isolation.sh   # needs Postgres 17 on :55432
```

Run both isolation checks after touching anything tenant-scoped. Never commit a
`.env` file. Demo mode (`NEXT_PUBLIC_DEMO_MODE=true`) needs no backend.
