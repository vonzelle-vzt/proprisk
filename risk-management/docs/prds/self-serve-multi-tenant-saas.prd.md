# PRD: Self-Serve, Hard-Isolated Multi-Tenant SaaS

**Status:** Shipped, unverified in production
**Owner:** VZT Tech Consulting

## Status (2026-09-05)

Shipped: tenancy core, the rule-pack engine, self-serve signup through shadow
mode, the versioned pack store, per-tenant credential vault, billing, the
staged-launch enforcement gate, and (landed after this PRD was written)
per-violation reports, live rule-pack decision persistence, the trader view,
and disputes — see [`violation-reports.prd.md`](./violation-reports.prd.md)
and `MASTER_PRD.md`.

Remaining, honestly: the multi-tenant build has not yet run in production. An
earlier single-tenant version of this engine ran against live funded accounts
at a firm that is not named here; the tenancy layer, the rule-pack engine and
the reports are newer, and are verified — a green test suite, a
machine-checked isolation suite, deterministic golden vectors — but verified
is not the same as proven in production. Only 2 of 10 provider adapters are
real (MatchTrader, Tradovate); the 7 presets ship unverified by design (see
"Key design decisions" below); realtime provider feeds for intraday-trailing
firms remain a poll/push snapshot pipeline, not streaming. Code: tenancy —
`risk-management/supabase/migrations/00015_tenancy.sql`,
`src/lib/db/tenant-scoped.ts`; rule packs — `src/lib/rulepack/`; staged launch
— `src/lib/rulepack/store.ts`, `docs/TAILORING.md` §6.

## Context

The platform was single-tenant-per-client: each prop-firm client got its own Supabase project, Vercel
deployment, domain, and branding (`client-onboarding-readiness.prd.md`). That model provisions a client
in about 2 hours with scripts and a runbook — fast for a services business, but it means N deployments,
N databases to patch, and no shared product to compound. This PRD covers converting that into one
deployment serving every tenant, self-serve from signup to enforcement.

## Problem

Two problems, not one, and conflating them produces the wrong architecture:

1. **Every firm defines "breach" differently**, and today that difference is coded as either N custom
   deployments or one rigid schema. Apex trails drawdown intraday; TopStep trails it end-of-day and
   locks it at the starting balance; FTMO doesn't trail at all; Lucid's funded product has no daily
   loss limit at all. None of that is a different feature — it's the same primitive with different
   parameters.
2. **Competitors hide pricing behind a sales call.** In a market of undifferentiated risk detectors
   (every trading platform already computes drawdown, in real time, better than a bolt-on vendor can),
   published pricing plus a self-service backtest that lets a firm prove the engine understands its
   rules — without talking to anyone — is a real position, not a gimmick.

## Thesis

Firms differ in **parameters**, not in **kind**. The correct unit of product is one closed catalog of
parameterised primitives (13 of them) plus an open, versioned configuration per tenant — never
tenant-authored code. This is what makes multi-tenancy safe to build at all: nothing a customer submits
is ever executed, so the security surface is "validate a JSON config," not "sandbox arbitrary logic."

Three properties fell out of studying real firms rather than being designed from imagination, and each
would have been missed by imagining rather than reading rulebooks:

- `enabled: false` must mean the rule **does not exist**, not that its threshold is generous — modelling
  Lucid's absent daily-loss limit as a very large number produces breach records that should never
  exist.
- `action` is independent of the threshold — The5ers Pro Growth *terminates* on a 3% daily loss;
  TopStep *pauses* on its equivalent. Same rule, same basis, different consequence.
- Rules are scoped by account phase — Tradeify enforces a 40% consistency rule during evaluation and
  drops it once funded.

## Scope delivered

Landed across nine commits (`6e70c0b` → `39be0cc`), in dependency order:

1. **Tenancy core** (`6e70c0b`, `d85a443`) — tenant dimension, RLS on every table, tenant context on
   guards, the scoped data-access layer (`tenantDb()`).
2. **Rule-pack engine** (`4bd21f8`) — the 13-primitive breach engine, parameterised per tenant.
3. **Self-serve signup + shadow mode** (`59c986a`) — signup, tenant-bound invites, support tickets,
   backtest-before-enforce.
4. **Versioned pack store** (`bbbe4a9`) — immutable-once-published packs, gated activation, plus
   `scripts/check-isolation.mjs`, the CI isolation guard.
5. **Per-tenant credential vault** (`b6d0129`) — AES-256-GCM envelope encryption, HKDF-derived per-tenant
   keys, provider token caches converted from module-scoped globals to tenant-keyed maps.
6. **Automation, billing, public surface** (`7ee55c7`) — per-tenant cron fan-out, Stripe billing tiered
   by funded accounts monitored, published landing/pricing pages, and the closure of a live RLS bypass
   (31 route handlers still calling `createAdminClient()`).
7. **Fraud-hunter tenant scoping** (`411dfed`) — the one module the conversion had missed; it was
   silently cross-tenant (see "Key design decisions" below).
8. **Staged-launch gate** (`462dc32`) — enforcement-approval gate, plus closing a real RLS gap: RLS is
   row-level and cannot stop a tenant admin from writing its own `plan_tier`/`status` columns, so
   `UPDATE` privilege on `tenants` is revoked and re-granted only on `name`/`branding_json`.
9. **Preset provenance + rule-pack UI + trader view + disputes + equity ingestion** (`337766d`,
   `39be0cc`) — the 7 presets shipped as unverified drafts with staleness tracking; the UI that makes
   rule packs actually reachable (they had engine, presets, and store but no route); the trader-facing
   headroom page; equity snapshot ingestion for intraday-trailing rules; disputes with pinned evidence;
   and making `tenantId` a required (not optional) parameter across the provider facade, forcing the
   compiler to find and fix ~55 call sites.

## Key design decisions, with reasoning

**Tenant claim in `app_metadata`, never `user_metadata`.** `user_metadata` is user-editable via
`supabase.auth.updateUser()`. Authorization read from it lets any signed-in user self-promote to admin —
this was a real defect elsewhere in the codebase (`guards.ts` had a fallback to it), which is why the CI
guard checks for it permanently rather than trusting review to catch it again.

**A pack is immutable once it leaves draft; editing forks a new version.** A breach decision has to
stay explicable years later in front of a disputing trader. Editing an active pack in place would
silently rewrite the rules a past decision was made under — a change forks a version instead, and every
decision pins the version that produced it.

**Activation is refused if the backtest missed a breach the firm's own platform caught.** This is
asymmetric by design: breaches the engine finds that the platform didn't are surfaced but non-blocking
(often the reason a firm is switching); breaches the platform caught that the engine missed are
blocking, unconditionally, because activating past that silently relaxes the firm's own rules. A run
that couldn't evaluate a rule is also blocking — "no breach" and "not checked" must never read the
same.

**Staged launch gates enforcement, not signup.** A firm self-serves the entire funnel — credentials,
presets, tuning, backtest — at zero risk, because none of it enforces. The single dangerous act,
flipping a pack to `active`, additionally needs a platform operator to have read the backtest
reconciliation while a tenant is flagged `enforcement_approval_required`. Reasoning stated in the commit:
gating with sales calls buys less safety than it appears to — a call doesn't catch a wrong
trailing-drawdown parameter, a backtest does. Sign-off is recorded per pack *version*, with the backtest
id the reviewer actually read, because "we reviewed this" is otherwise unfalsifiable at the exact moment
a trader disputes a termination.

**`tenantId` is a required parameter, never optional, on every path that reaches a provider or a
detector.** Optional tenancy is precisely how a real hole happened: the fraud-hunter detectors took no
tenant argument at all, used the service-role client, and correlated every account in the database
against every other — Firm A would have received investigations naming Firm B's accounts. Making the
parameter required (not "encouraged") let the compiler enumerate every call site instead of relying on
someone remembering to pass it.

**Column-level privileges, not just RLS, protect `tenants`.** RLS decides which *rows* a tenant can
write, never which *columns*. Without an explicit revoke, a tenant's own admin could raise its own
`plan_tier`, lift `max_accounts`, or switch off its own enforcement gate through the same "update your
own tenant" policy that legitimately lets it rename itself. `UPDATE` is revoked on `tenants` and
re-granted only on an allowlist (`name`, `branding_json`), so a column added later is not
customer-writable by default.

**Trader access is a tokenized link, not a session.** Traders are not tenant members. Only a sha256 of
the token is stored. The headroom numbers come from the same primitives the breach engine uses, so the
trader page and the breach notice cannot disagree — which is the point: most disputes are surprise, not
disagreement, and a trader who watched the floor move all week doesn't file a chargeback when it's hit.

**Presets ship marked `unverified`, with a 90-day staleness window, not marked "verified" optimistically.**
A preset is a claim about somebody else's published rules, and firms revise those without telling
anyone. The risk isn't that a preset is wrong on day one — it's that it silently stops being right while
carrying the authority of a shipped default. A test asserts all seven are unverified, so marking one
verified requires someone to actually do the verification.

## Verification

- 441 tests across 47 files (`npx vitest run`), `tsc --noEmit`, lint, isolation guard, and production
  build all clean as of the last commit (`39be0cc`).
- `supabase/tests/verify-isolation.sh` applies all migrations to a real Postgres 17 as the `authenticated`
  role with live JWT claims and confirms: Firm A sees only its own rows; a cross-tenant read by explicit
  id returns nothing; cross-tenant insert/update-to-move/delete are all refused; a claimless token sees
  nothing; a tenant OWNER can rename and rebrand itself but cannot write `plan_tier`, `status`,
  `max_accounts`, or the enforcement gate.
- A dedicated two-tenant fraud-hunter test seeds byte-identical bait across both firms (same email,
  country, plan, balances, trade timing, payout windows) and asserts no finding's account_ids ever mix
  the two tenants.
- `node scripts/check-isolation.mjs` runs in CI and fails the build on a new table missing `tenant_id`, a
  permissive policy, a route using the admin client, or role/tenant read from `user_metadata`.

## Non-goals / explicitly deferred

- Realtime provider feeds for intraday-trailing firms — snapshot ingestion (poll + push) ships instead;
  streaming replaces it later. See `HOW-IT-WORKS.md` §6.2.
- Verifying the 7 presets against firms' actual published rulebooks — they ship as unverified drafts by
  design, not as a placeholder for verification that ran out of time.
- Adapters for the other 8 trading platforms (DXtrade, TradeLocker, cTrader, MT5, Rithmic, TopstepX,
  CQG, NinjaTrader) — documented stubs, built on client demand.

## Open items (honest)

- **The multi-tenant build has not yet run in production.** An earlier single-tenant version of the
  engine ran against live funded accounts at a firm not named here; the tenancy layer and rule-pack
  engine are newer. Verified means tested against a real Postgres and a large deterministic suite.
- Column-level privilege protection currently covers `tenants`; it is the mechanism, not a table list —
  any future customer-writable table needs the same allowlist-not-denylist treatment considered
  explicitly.
