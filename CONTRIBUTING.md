# Contributing

## Prerequisites

- Node 20+
- npm
- Docker, if you're going to run the SQL isolation suite
  (`supabase/tests/verify-isolation.sh` builds a real Postgres 17 in a
  container)

## Setup

```
scripts/setup.sh --demo
```

This installs dependencies, copies `.env.local.example` to `.env.local` (it
never overwrites an existing one), and runs a typecheck smoke test. It's
idempotent — safe to re-run any time. See
[`docs/INSTALL.md`](docs/INSTALL.md) for `--live` mode, Docker, and
production paths.

For most work you don't need real credentials at all: demo mode runs
entirely on mock data, with auth bypassed and no live provider or Supabase
calls. Start there unless your change specifically needs a real database or
provider connection.

## Commands

Run these from `risk-management/`:

```
npm run dev               # local dev server
npm run lint
npm run typecheck
npm run test              # vitest run
npm run test:watch
npm run check:isolation   # static isolation guard, scripts/check-isolation.mjs
bash ../supabase/tests/verify-isolation.sh   # live isolation suite, needs Docker
```

**Run both isolation checks after touching anything tenant-scoped** — a new
table, a new query, a new background job, anything under
`src/lib/db/tenant-scoped.ts` or `src/lib/auth/`. `check:isolation` is fast
and catches static mistakes (missing `tenant_id`, a permissive policy, a
`user_metadata` read); `verify-isolation.sh` is slower and asserts the
behavior against a real database. Neither is a substitute for the other.

## Adding a table

Copied from [`risk-management/docs/ISOLATION.md`](risk-management/docs/ISOLATION.md) —
follow it exactly, in order:

1. `tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`.
2. Copy the RLS block from `00015` verbatim — four authenticated policies plus
   the `service_role` policy, with `ENABLE` **and** `FORCE ROW LEVEL SECURITY`.
   Forcing matters: the table owner bypasses RLS otherwise, and migrations run
   as owner.
3. Lead every index with `tenant_id`.
4. Scope any UNIQUE constraint that is keyed on a value the provider issues.
5. Run both checks above.

If the table is genuinely global, add it to `GLOBAL_TABLES` in **both**
`scripts/check-isolation.mjs` and `src/lib/db/tenant-scoped.ts`, with the
reason. Making something global should be a decision someone signed.

## Adding a provider adapter

Adapters live in `src/lib/providers/adapters/`. To add one:

1. Implement the `TradingProvider` interface
   (`src/lib/providers/interface.ts`).
2. Register it in `src/lib/providers/registry.ts` with its `ProviderMeta` —
   asset class, whether it's a manager/broker feed or per-trader access,
   transport, and `docsUrl` pointing at the platform's real API docs.
3. Mark the adapter as a stub (throw `NotConfiguredError`, or clearly comment
   the mock path) until it has been verified against the official API docs.
   Do not claim a live integration you haven't tested against a real account.

## Adding a rule-pack preset

Presets live in `src/lib/rulepack/presets.ts`. Every preset must carry a
`provenance` block with a `source` URL (the firm's public rulebook) and a
`verifiedAt` date. A preset with no `verifiedAt` ships as `unverified` and is
treated as a starting point, not a published rulebook — see the confidence
logic at the top of that file before adding one.

## Commits and PRs

Use [Conventional Commits](https://www.conventionalcommits.org/) style commit
messages (`feat:`, `fix:`, `docs:`, `chore:`, etc.).

Before opening a PR:

- `npm run lint && npm run typecheck && npm run test` all pass.
- `npm run check:isolation` passes if you touched anything tenant-scoped, and
  `verify-isolation.sh` too if you touched migrations or RLS.
- `npm run check:banned-terms` is clean — this repo's public-release gate
  fails on former customer names, private infrastructure identifiers, and
  personal tooling references. No customer names, no secrets, no personal
  tooling in anything you commit.
- No `.env*` files are staged.
- Docs are updated if behavior changed.

MIT inbound = outbound: by submitting a contribution, you agree it's licensed
under this repository's MIT license.
