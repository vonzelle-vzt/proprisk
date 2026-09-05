# PropRisk — the application

The Next.js 14 app. **Start at the [repository README](../README.md)** — it says
what this is and why it is shaped this way. This file only covers running it.

## Documentation

| Document | What is in it |
|---|---|
| [`../README.md`](../README.md) | What PropRisk is, the quick start, the honest current state |
| [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) | The design argument: the four flows, why rule packs are parameters not code, the staged launch |
| [`../docs/USAGE.md`](../docs/USAGE.md) | The operator's manual: every screen, what each action writes, the demo path to try it |
| [`docs/ISOLATION.md`](docs/ISOLATION.md) | The five-layer tenant isolation model and how it is verified |
| [`../docs/BUILD-SPEC.md`](../docs/BUILD-SPEC.md) | Rebuild this system, milestone by milestone, each with a verification command |
| [`../docs/REFERENCE.md`](../docs/REFERENCE.md) | Every page, route, table and directory |
| [`../docs/TAILORING.md`](../docs/TAILORING.md) | Make it your firm's: rule packs, branding, adapters, backtests |
| [`../docs/SELF-HOSTING.md`](../docs/SELF-HOSTING.md) | Migrations, environment, deployment, rotation, backups |
| [`../DESIGN.md`](../DESIGN.md) | The visual contract — read before any UI work. Product requirement documents live in [`docs/prds/`](docs/prds/) |

## Run it

```bash
npm install
cp .env.local.example .env.local   # ships with NEXT_PUBLIC_DEMO_MODE=true
npm run dev                        # http://localhost:3000
```

Demo mode needs no backend: auth is bypassed and every API returns coherent mock
data. To run against a real Supabase project, set `NEXT_PUBLIC_DEMO_MODE=false`
and follow [`../docs/SELF-HOSTING.md`](../docs/SELF-HOSTING.md).

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | vitest, single run |
| `npm run check:isolation` | The CI isolation guard |
| `npm run check:banned-terms` | Nothing private ships |
| `bash supabase/tests/verify-isolation.sh` | The SQL isolation suite against a real Postgres 17 on port 55432 |

Run **both** isolation checks after touching anything tenant-scoped: the guard
asks whether isolation will still hold tomorrow, the SQL suite whether it holds.

## Environment

Every variable is annotated in [`.env.local.example`](./.env.local.example) —
copy it rather than working from a list. Demo mode needs nothing; real operation
needs the three Supabase values plus `CRON_SECRET`, `PLATFORM_ADMIN_SECRET`,
`CONNECTIONS_MASTER_KEY` and `NEXT_PUBLIC_APP_URL`. Everything else (Redis,
Stripe, email, providers, branding) is optional and degrades cleanly when unset.
Never commit a `.env` file.

## Layout

`src/app` pages and ~100 routes · `src/lib/rulepack` the engine ·
`src/lib/providers` ten adapters · `src/lib/db/tenant-scoped.ts` the scoped
data-access layer · `supabase/migrations` append-only, tenancy from `00015`.
