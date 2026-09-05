# Reference

The exhaustive inventory: every page, every API route, every table, and the
directory layout. This exists so the narrative documents can stay short — read
[`../README.md`](../README.md) first, then [`USAGE.md`](./USAGE.md) if you are
running the thing or [`BUILD-SPEC.md`](./BUILD-SPEC.md) if you are rebuilding
it, then come here when you need to know exactly what is where.

Everything below was read out of `risk-management/src` and
`risk-management/supabase/migrations`. If it disagrees with the code, the code
is right and this file is a bug.

---

## Pages

All pages under `(dashboard)` require a session with both a role and a tenant
claim. `(marketing)`, `(auth)` and `(trader)` do not.

| Route | Group | What it shows |
|---|---|---|
| `/` | root | Routes a visitor by session: marketing when signed out, dashboard when signed in |
| `/home` | marketing | Public landing page |
| `/pricing` | marketing | Published pricing, tier by funded accounts monitored |
| `/login` | auth | Sign in |
| `/signup` | auth | Self-serve tenant creation — creates the firm and its owner |
| `/accept-invite` | auth | Redeem a tenant-bound team invite |
| `/risk` | dashboard | Risk dashboard: severity distribution, violation breakdown, flagged accounts |
| `/payouts` | dashboard | Pending payouts with risk checks, IP checks, and the pre-approval workflow |
| `/history` | dashboard | Decided payouts with the risk snapshot each decision was made on |
| `/violations` | dashboard | Violations grouped by rule, with a PDF and CSV download on every row |
| `/violations/[id]` | dashboard | One violation: the rule as written, the arithmetic, the contributing trades, the downloads |
| `/violations/account/[accountId]` | dashboard | Every violation on one account, with an account-wide CSV export |
| `/accounts/[login]` | dashboard | One account's detail and trade-level analysis |
| `/deductions` | dashboard | Executed deductions, with internal-versus-platform comparison |
| `/rules` | dashboard | Rule packs: versions, status, which one is active per asset class |
| `/rules/new` | dashboard | Preset picker and tuning wizard |
| `/rules/[id]` | dashboard | One pack: edit while draft, promote to testing, diff, backtest, impact preview, activate |
| `/disputes` | dashboard | Dispute cases with the evidence pack pinned at decision time; overturn rate per rule |
| `/evidence/[id]` | dashboard | One evidence pack: trade tape, rule-by-rule scoring, hash-chained audit trail |
| `/enforcement` | dashboard | The enforcement queue — approve or reject, singly or in batch. Escalation and expiry are automatic (`/api/cron/enforce`), not buttons |
| `/reviewer` | dashboard | Nightly deduction-verification run history |
| `/alerts` | dashboard | Live breach feed for the selected asset class |
| `/network` | dashboard | Cross-account graph: copy rings, shared identity, coordinated payouts |
| `/connections` | dashboard | Read-only status board for all ten adapters. Credentials are created and validated through `/api/connections/*`, not from this page |
| `/email-log` | dashboard | Outbound email log |
| `/ai` | dashboard | Analytics chat over the firm's own data |
| `/settings` | dashboard | Account info, per-asset risk rules, password, sign out |
| `/a/[token]` | trader | A trader's own live headroom, reached by a tokenized link with no session |

A **Forex / Futures toggle** in the header re-scopes every dashboard page; data
hooks append `?assetClass=` and refetch.

---

## API routes

Methods below are the handlers actually exported by each `route.ts`.

### Tenancy, billing and support

| Route | Methods | Purpose |
|---|---|---|
| `/api/tenancy/signup` | POST | Create a tenant and its owner. Public — runs before the caller has a claim |
| `/api/tenancy/invites` | GET, POST | List and issue tenant-bound invites |
| `/api/tenancy/invites/accept` | POST | Redeem an invite and mint a tenant-scoped session. Public |
| `/api/billing/checkout` | POST | Stripe checkout session |
| `/api/billing/portal` | POST | Stripe customer portal |
| `/api/billing/webhook` | POST | Signature-verified Stripe webhook. Public — Stripe cannot present a cookie |
| `/api/support/tickets` | GET, POST | Support requests with diagnostics, mailed to `SUPPORT_INBOX_EMAIL` |

### Connections — per-tenant platform credentials

| Route | Methods | Purpose |
|---|---|---|
| `/api/connections` | GET, POST | List and create a firm's platform connections; secrets returned masked |
| `/api/connections/[provider]` | GET, PUT, DELETE | Manage one connection |
| `/api/connections/[provider]/validate` | POST | Prove the credentials can actually read this firm's accounts |

### Rule packs

| Route | Methods | Purpose |
|---|---|---|
| `/api/rulepack` | GET, POST | List packs; create a draft |
| `/api/rulepack/presets` | GET | The seven presets: id, label, description, asset class and the pack. Provenance and confidence live in `src/lib/rulepack/presets.ts` and are not returned |
| `/api/rulepack/[id]` | GET, PATCH | Read a pack; edit it while it is still a draft |
| `/api/rulepack/[id]/backtest` | GET, POST | Run a shadow-mode backtest; read the last run |
| `/api/rulepack/[id]/diff` | GET | Plain-language diff between two versions |
| `/api/rulepack/[id]/impact` | GET | Which currently-open accounts change status under a candidate pack |
| `/api/rulepack/[id]/activate` | POST | Activate. Refused without a clean backtest, and without sign-off while gated |
| `/api/rulepack/[id]/promote` | POST | Draft to testing. A pack in testing is evaluated but never enforces |
| `/api/platform-admin/rule-packs` | GET, POST | Platform-operator review queue and sign-off. Gated on `PLATFORM_ADMIN_SECRET` |

### Violations and reports

| Route | Methods | Purpose |
|---|---|---|
| `/api/violations` | GET | Violation list from the `violations` table, filterable. The operator pages read `/api/platform/violations` instead, so this route has no demo fixture and returns 401 in demo mode |
| `/api/violations/[id]` | GET | One violation with its network evidence |
| `/api/violations/[id]/report` | GET, POST | `GET ?format=pdf\|csv\|json` renders the persisted report payload; `POST` regenerates it |
| `/api/violations/account/[accountId]/report` | GET | Account-wide violation CSV |
| `/api/platform/violations` | GET | Violation records from the connected platform, news-verified |
| `/api/platform/violations/[accountId]` | GET | Per-account platform violation detail |
| `/api/platform/violations/challenges` | GET | The same for challenge accounts |

### Trader-facing

| Route | Methods | Purpose |
|---|---|---|
| `/api/accounts/[login]/trader-link` | GET, POST, DELETE | Mint, list and revoke a tokenized trader link. Only the sha256 hash is stored |
| `/api/trader/[token]` | GET | A trader's own live headroom. Public path; the token is the whole authentication |
| `/api/trader/[token]/violations/[id]/report` | GET | The trader's own copy of a violation report, scoped to their account |

### Disputes

| Route | Methods | Purpose |
|---|---|---|
| `/api/disputes` | GET, POST | List; open a dispute with the evidence pack pinned at decision time |
| `/api/disputes/[id]` | GET | Case detail |
| `/api/disputes/[id]/transition` | PATCH | State change; joins the hash chain naming the human |
| `/api/disputes/overturn-rate` | GET | Overturn rate per rule |

### Ingestion

| Route | Methods | Purpose |
|---|---|---|
| `/api/ingest/equity-snapshots` | POST | Push equity samples, so intraday-trailing rules become evaluable |
| `/api/ingest/keys` | POST | Mint a per-tenant ingestion key |

### Platform data, providers and exposure

| Route | Methods | Purpose |
|---|---|---|
| `/api/platform/dashboard` | GET | Live risk dashboard data |
| `/api/platform/dashboard/challenges` | GET | The same for challenge accounts |
| `/api/platform/deductions` | GET | Deduction records |
| `/api/platform/deductions/summary` | GET | Aggregated deductions with comparison metrics |
| `/api/platform/deductions/challenges` | GET | Challenge-account deductions |
| `/api/platform/challenges/search` | GET | Search challenge accounts |
| `/api/platform/challenges/analyze` | POST | Analyze one challenge account |
| `/api/providers` | GET | All ten adapters with health, asset class and access model |
| `/api/providers/enforce` | POST | Route restrict / suspend / flatten to the owning adapter |
| `/api/exposure` | GET | Firm-wide cross-asset exposure |
| `/api/alerts` | GET | Live breach alerts for the selected asset class |
| `/api/forecast/liability` | GET | Deterministic 7 and 30-day P50/P90 payout-liability forecast |
| `/api/network/graph` | GET | Cross-account ring and graph data |
| `/api/accounts` | GET | Account list |
| `/api/accounts/[login]` | GET | One account |

Every route in this group accepts `?assetClass=forex|futures`.

### Payouts and history

| Route | Methods | Purpose |
|---|---|---|
| `/api/payouts` | GET | Pending payouts |
| `/api/payouts/[id]` | GET, PATCH | One payout; decide it |
| `/api/payouts/[id]/risk-check` | POST | On-demand risk check |
| `/api/payouts/[id]/analyze` | POST | Explainable decision: cited rules and the arithmetic |
| `/api/payouts/[id]/preapprove` | POST | Pre-approval workflow. Rate limited |
| `/api/payouts/ip-check` | POST | VPN / proxy / TOR / datacenter check. Rate limited |
| `/api/payouts/summary` | GET | Summary statistics |
| `/api/payouts/violation-email` | GET, POST | Draft and send a payout violation notice |
| `/api/history` | GET | Paginated decided-payout history |
| `/api/history/[id]` | GET | One history record |
| `/api/history/summary` | GET | Aggregated summary |
| `/api/history/sync` | POST | Import payouts decided outside the platform |

### Risk engine

| Route | Methods | Purpose |
|---|---|---|
| `/api/risk/pretrade-evaluate` | POST | Pre-trade risk evaluation |
| `/api/risk/profiles` | GET, POST | Risk profile CRUD |
| `/api/risk/profiles/[id]/activate` | POST | Activate a profile |
| `/api/risk/dashboard` | GET | Internal risk dashboard |
| `/api/risk/events` | POST | Ingest a risk event |
| `/api/risk/alerts` | GET | Risk alert list |
| `/api/risk/alerts/[id]/ack` | POST | Acknowledge an alert |
| `/api/risk/alerts/[id]/resolve` | POST | Resolve an alert |
| `/api/risk/reports/session` | GET | Session reports |
| `/api/risk/reports/session/generate` | POST | Generate a session report |

### Enforcement, fraud and review

| Route | Methods | Purpose |
|---|---|---|
| `/api/enforcement/queue` | GET | The queue, filterable |
| `/api/enforcement/queue/[id]` | PATCH, DELETE | `PATCH` decides one item — `approved` or `rejected` only, no other verb. `DELETE` drops one, or de-duplicates the pending queue with the id `cleanup-duplicates` |
| `/api/enforcement/batch` | POST | Batch approve or reject |
| `/api/enforcement/summary` | GET | Queue statistics |
| `/api/enforcement/history/[accountId]` | GET | One account's enforcement history |
| `/api/fraud-hunter/investigations` | GET | Findings, filterable |
| `/api/fraud-hunter/investigations/[id]` | GET, PATCH | Read and update a finding |
| `/api/fraud-hunter/scan` | POST | Manual scan. Rate limited |
| `/api/reviewer/runs` | GET | Nightly reviewer run history |
| `/api/evidence` | POST | Build an evidence pack |
| `/api/evidence/[id]` | GET | Read one |
| `/api/deductions` | GET | Deduction records |
| `/api/deductions/execute` | POST | Execute an approved deduction |
| `/api/deductions/summary` | GET | Aggregated deductions |
| `/api/emails` | GET | Outbound email log |
| `/api/emails/send` | POST | Send a drafted notice |
| `/api/challenges/violation-email` | GET, POST | Draft and send a challenge-account notice |
| `/api/ai/chat` | POST | Analytics chat. Rate limited |
| `/api/reports/morning` | POST | Generate the morning risk report |

### System and cron

`/api/health` is public. Every `/api/cron/*` route requires
`Authorization: Bearer $CRON_SECRET`, checked in `middleware.ts` **and** again
in the handler, and enforced even in demo mode.

| Route | Method | Schedule (`vercel.json`) | Purpose |
|---|---|---|---|
| `/api/health` | GET | — | Environment, Supabase and Redis probes with latency |
| `/api/cron/ingest-trades` | GET | `* * * * *` | Pull accounts and trades per tenant |
| `/api/cron/detect-violations` | GET | `*/5 * * * *` | Evaluate the active rule pack; persist decisions |
| `/api/cron/process-violations` | GET | `* * * * *` | Drain the violation queue |
| `/api/cron/sample-equity` | GET | `*/5 * * * *` | Poll equity snapshots |
| `/api/cron/fraud-hunter` | GET | `*/15 * * * *` | Cross-account fraud scan |
| `/api/cron/enforce` | GET | `*/15 * * * *` | Expire stale queue items and escalate |
| `/api/cron/reviewer` | GET | `30 2 * * 1-6` | Nightly deduction verification |
| `/api/cron/morning-report` | GET | `0 12 * * *` | Daily summary per tenant |
| `/api/cron/sync-news` | GET | `0 6 * * 1` | Economic calendar sync |
| `/api/cron/backfill-news` | POST | — | Manual backfill; not scheduled |

Every cron fans out with `fanOutToTenants()` at bounded concurrency, isolates
per-tenant failure, and reports one outcome per tenant in its response body.

---

## Database tables

Every table listed here except the four global ones carries
`tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`, `ENABLE`
and `FORCE ROW LEVEL SECURITY`, four `authenticated` policies keyed on
`tenant_id = auth_tenant_id()` with `WITH CHECK` on the write paths, and one
`service_role` policy. Indexes lead with `tenant_id`.

### Tenancy and access

| Table | Migration | Purpose |
|---|---|---|
| `tenants` | 00015 | One prop firm. The unit of isolation and billing. `plan_tier`, `status`, `max_accounts` and `enforcement_approval_required` are column-privilege-protected against the firm's own admin |
| `tenant_members` | 00015 | Membership and role: `owner`, `admin`, `risk_manager`, `risk_analyst`, `viewer` |
| `tenant_invites` | 00015 | Tenant-bound invites; only the token hash is stored |
| `trader_access_tokens` | 00021 | Tokenized trader links; sha256 hash only, with expiry and revocation |
| `ingest_keys` | 00022 | Per-tenant keys for pushing equity snapshots |
| `connections` | 00016 | Per-tenant platform credentials, envelope-encrypted, with validation status |

### The rule-pack engine

| Table | Migration | Purpose |
|---|---|---|
| `rule_packs` | 00018 | Versioned, content-hashed, immutable once past draft. Partial unique index enforces at most one active pack per (tenant, asset class) |
| `breach_decisions` | 00018 | One decision, pinned to the pack version that produced it, with the evidence JSON and an idempotency key |
| `backtest_runs` | 00018 | Shadow-mode runs and their reconciliation |

### Accounts, trades and breaches

| Table | Migration | Purpose |
|---|---|---|
| `accounts` | 00001 | Local account state: login, balances, phase, restrictions |
| `trades` | 00001 | Trade history pulled from the firm's platform |
| `violations` | 00001, widened in 00026 | Detected violations, linked to their enforcement item. `violation_type` became TEXT with a widened CHECK in 00026 so a rule-pack breach can be identified by its rule id; a partial unique index on the engine's idempotency key makes "one violation per decision" a database guarantee |
| `violation_reports` | 00025 | The persisted, content-hashed report payload behind every PDF and CSV |
| `deductions` | 00001 | Executed balance adjustments |
| `equity_snapshots` | 00022 | Polled and pushed equity samples, recording the sampling interval alongside the data |
| `account_snapshots` | 00001 | Latest account, user and violation state |
| `account_violation_history` | 00001 | Repeat-offender tracking with sliding windows |
| `challenge_violation_cache` | 00001 | Cached challenge-account analysis |
| `challenge_sync_progress` | 00001 | Challenge sync bookkeeping |

### Decisions, evidence and disputes

| Table | Migration | Purpose |
|---|---|---|
| `audit_log` | 00001 | Append-only, SHA-256 hash-chained action log |
| `evidence_packs` | 00001 | Assembled dossiers behind a decision |
| `payout_decisions` | 00001 | Explainable payout decisions with cited rules and the arithmetic |
| `payout_history` | 00001 | Full payout snapshots, pending through decided |
| `enforcement_queue` | 00001 | Recommendations awaiting human approval, with escalation state |
| `disputes` | 00023 | Trader disputes, pinned to the evidence pack that existed at decision time |
| `reviewer_runs` | 00001 | Nightly reviewer run history and metrics |
| `fraud_investigations` | 00001 | Cross-account findings with confidence scoring |

### Risk engine, billing, reporting

| Table | Migration | Purpose |
|---|---|---|
| `risk_profiles` | 00001 | Named risk configurations |
| `risk_pretrade_decisions` | 00001 | Pre-trade evaluation results |
| `risk_trade_events` | 00001 | Trade event stream |
| `risk_violations` | 00001 | Risk-engine violations |
| `risk_alerts` | 00001 | Alert lifecycle |
| `risk_session_reports` | 00001 | Session reports |
| `subscriptions` | 00019 | Stripe subscription state per tenant |
| `usage_snapshots` | 00019 | Funded accounts monitored, for metering |
| `morning_reports` | 00024 | Generated daily summaries |
| `emails` | 00001 | Outbound email log |
| `support_tickets` | 00017 | Support requests with diagnostics |

### Global tables

Four tables are deliberately not tenant-scoped, and that decision is written
down in two places — `GLOBAL_TABLES` in `src/lib/db/tenant-scoped.ts` and in
`scripts/check-isolation.mjs` — each with its reason, so making something
global is an act somebody signed.

| Table | Why it is global |
|---|---|
| `news_events` | The economic calendar is identical for every firm |
| `tenants` | The tenant registry itself |
| `tenant_members` | Its `tenant_id` is the foreign key, not a scope |
| `tenant_invites` | Same |

`violation_config` existed in the baseline schema and is dropped in `00018`; it
was never read by application code and rule packs supersede it.

---

## Project structure

```
.
├── README.md                     the front door
├── DESIGN.md                     the visual contract — read before any UI work
├── LICENSE                       MIT
├── SECURITY.md                   how to report a vulnerability
├── CONTRIBUTING.md               how to propose a change
├── CODE_OF_CONDUCT.md
├── AGENTS.md / CLAUDE.md         conventions for coding agents
├── docs/
│   ├── BUILD-SPEC.md             rebuild the system from scratch, milestone by milestone
│   ├── USAGE.md                  the operator's manual, screen by screen
│   ├── TAILORING.md              make it your firm's
│   ├── SELF-HOSTING.md           run it yourself
│   ├── REFERENCE.md              this file
│   ├── architecture.md           three diagrams
│   ├── agent-prompts/            copy-paste prompts for a coding agent
│   └── screenshots/
├── scripts/release/
│   ├── check-banned-terms.sh     no former customer or private identifier ships
│   ├── check-doc-links.mjs       every relative link in every doc resolves
│   └── export-public.sh          gated snapshot for the public repository
├── .github/workflows/            ci.yml (lint, typecheck, test, isolation, build)
│                                 security.yml (secret scan, banned terms, audit)
└── risk-management/              the Next.js application
    ├── vercel.json               nine cron schedules
    ├── .env.local.example        every environment variable, annotated
    ├── scripts/check-isolation.mjs
    ├── supabase/
    │   ├── migrations/           00001 baseline, tenancy from 00015, append-only
    │   └── tests/verify-isolation.sh
    └── src/
        ├── app/
        │   ├── (marketing)/      home, pricing
        │   ├── (auth)/           login, signup, accept-invite
        │   ├── (trader)/a/[token]/
        │   ├── (dashboard)/      the operator console
        │   └── api/              ~100 route handlers, including api/cron/
        ├── components/           ui/ plus one directory per feature area
        ├── config/               brand.ts, violations.ts
        ├── hooks/                data hooks, asset-class aware
        ├── lib/
        │   ├── rulepack/         schema, primitives, presets, store, evaluate,
        │   │                     live, backtest, diff, impact, session, vectors
        │   ├── providers/        interface, registry, adapters/ (10)
        │   ├── db/               tenant-scoped.ts — the scoped data-access layer
        │   ├── auth/             guards.ts, public-routes.ts
        │   ├── tenancy/          signup, invites, provisioning
        │   ├── connections/      per-tenant credential vault
        │   ├── crypto/           envelope.ts — AES-256-GCM + per-tenant HKDF
        │   ├── audit/            chain.ts — SHA-256 hash chain
        │   ├── evidence/         builder.ts, types.ts
        │   ├── disputes/         lifecycle.ts
        │   ├── trader/           tokens.ts
        │   ├── reports/          violation report payload + PDF and CSV renderers
        │   ├── export/           csv.ts — the shared RFC 4180 writer
        │   ├── ingest/           equity snapshot polling and push
        │   ├── enforcement/      queue manager and severity scoring
        │   ├── fraud-hunter/     five cross-account detectors, tenant-scoped
        │   ├── reviewer/         nightly deduction verification
        │   ├── billing/          metering, entitlements, webhook handler
        │   ├── risk/futures/     daily loss, trailing drawdown, position limit
        │   ├── payouts/          risk analysis, enrichment, snapshots
        │   ├── platform/         provider-neutral data facade
        │   ├── demo/ mock/       demo mode and its datasets
        │   ├── rate-limit/       Redis with an in-memory fallback
        │   └── logging/ env/     structured logs, environment validation
        ├── styles/globals.css    the nine design tokens
        └── types/
```
