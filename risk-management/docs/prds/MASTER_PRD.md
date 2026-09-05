# Risk Management Platform — Master PRD

**Version:** 3.1
**Last Updated:** 2026-09-05
**Owner:** VZT Tech Consulting

## Status (2026-09-05)

See [`README.md`](./README.md) in this directory for what each PRD below
covers and its individual status. Honest current state: the multi-tenant
build has not yet run in production. An earlier single-tenant version of
this engine ran against live funded accounts at a firm that is not named
here; the tenancy layer, the rule-pack engine and the reports below are
newer, and are verified — a green test suite, a machine-checked isolation
suite, deterministic golden vectors — but verified is not the same as
proven in production. See `risk-management/docs/HOW-IT-WORKS.md` §8.

**2026-09-05 update:** the public marketing surface (`/home`, `/pricing`)
has been removed; this is a self-hosted admin console, not a hosted product
with a public site. A signed-out visitor lands on `/login`. Billing is
optional, behind `BILLING_ENABLED` (default `false`), for anyone who chooses
to run this as a hosted service for other firms.

## Product Vision

**White-label, multi-asset (Futures + Forex) risk-management platform for prop trading firms** — one risk
desk across every major trading platform. Real-time violation detection, automated enforcement with human
oversight, cross-account fraud detection, and comprehensive audit trails. Resold by VZT to any prop firm;
each firm connects its own platforms (MatchTrader, DXtrade, TradeLocker, cTrader, MT4/MT5, Tradovate,
Rithmic, TopstepX, CQG, NinjaTrader). Ships with a fully working public **demo mode** for sales.

## Feature PRDs

| PRD | Status | Priority | Description |
|-----|--------|----------|-------------|
| [Self-Serve Multi-Tenant SaaS](self-serve-multi-tenant-saas.prd.md) | Shipped | P0 | One deployment, many firms; five-layer isolation, rule packs, backtest gate, staged launch |
| [Fraud Hunter Agent](autonomous-agents-fraud-hunter.prd.md) | Implemented | P1 | Cross-account fraud detection (5 detectors) |
| [Violation Enforcer Agent](autonomous-agents-violation-enforcer.prd.md) | Implemented | P1 | Severity scoring, repeat offender tracking, enforcement queue |
| [Violation Reports](violation-reports.prd.md) | Shipped | P1 | Per-violation PDF/CSV/JSON rendered from a persisted `violation_reports` payload, plus an account-wide CSV and a trader self-service copy |
| Live decision persistence | Shipped | P0 | The detection cron persists rule-pack `breach_decisions` and creates `violations` rows linked to their enforcement item, and reports `skipped` rules rather than passing silently |

## Core Platform (Pre-Agent)

### Implemented Features
- Pending payout management with enrichment pipeline
- 9 violation detection engines (profit cap, overleveraging, HFT, martingale, news, grid, copy, overnight, violations)
- Automated deduction execution with audit trail
- Payout history with full risk snapshots
- AI analytics chat bot (13+ intents)
- Risk dashboard with severity distribution
- IP geolocation checking (VPN/proxy/TOR detection)
- Morning report generation
- News event integration (FXStreet + Forex Factory)
- Pre-trade risk evaluation
- Challenge account analytics

### Database
`supabase/migrations/` is append-only and applied in filename order. `00001` is
the consolidated baseline schema (core tables, risk engine, payout history,
challenge cache, account snapshots, news events, fraud investigations,
enforcement queue, reviewer runs, evidence packs, payout decisions); tenancy and
row-level security arrive in `00015`; `00016`-`00024` add connections, support
tickets, rule packs, billing, the enforcement gate, trader access, equity
snapshots, disputes and morning reports. See
[`../../../docs/REFERENCE.md`](../../../docs/REFERENCE.md) for every table.

### Cron Jobs
| Job | Schedule | Purpose |
|-----|----------|---------|
| ingest-trades | Every minute | Trade data sync |
| detect-violations | Every 5 min | Run violation engines |
| process-violations | Every minute | Queue processing |
| sync-news | Weekly, Monday 06:00 | News calendar sync |
| fraud-hunter | Every 15 min | Cross-account fraud scan |
| enforce | Every 15 min | Expire stale + auto-escalate |
| reviewer | 9:30 PM EST (Sun-Fri) | Nightly deduction verification against the legacy single-vendor integration |

## Multi-Provider Layer (v3.0)

`src/lib/providers/` — a generic `TradingProvider` interface + registry + 10 adapters across both asset
classes, of which MatchTrader (forex) and Tradovate (futures) are live and eight are documented stubs. Demo mode (`NEXT_PUBLIC_DEMO_MODE`) serves coherent mock data with no live backend. Live
per-provider via `PROVIDER_<ID>_ENABLED=true` + creds. Futures risk engine in `src/lib/risk/futures/`.
New routes: `/connections` (integrations), `/alerts` (live breaches), `/api/{providers,exposure,alerts}`.

## Architecture

Next.js 14 (App Router) + Supabase + multi-provider trading-platform adapters + Upstash Redis + Vercel.
Deployed on Vercel (demo mode).
