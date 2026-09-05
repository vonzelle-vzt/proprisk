# PRD: Per-Violation Decision Reports

**Status:** Shipped
**Priority:** P1
**Owner:** Risk Team
**Date:** 2026-09-05

## Status (2026-09-05)

Shipped end to end: the report shape, the persisted table, PDF/CSV/JSON
rendering, three endpoints (operator single-violation, operator account-wide
CSV, trader self-service), and demo-mode coverage with no backend. Code:
`risk-management/src/lib/reports/violation/` (`types.ts`, `build.ts`,
`render-pdf.ts`, `render-csv.ts`, `demo.ts`, `index.ts`),
`risk-management/supabase/migrations/00025_violation_reports.sql`.

## Problem

A breach decision produces a trader notice
(`docs/HOW-IT-WORKS.md` §2 Flow 3), but before this feature the notice's
underlying evidence — the trade tape, the arithmetic, the rule as it read at
the time — was not assembled into a single artifact a risk manager could hand
to a disputing trader, a payment processor, or a regulator months later. It
lived scattered across `violations`, `breach_decisions`, `equity_snapshots`
(pruned after 7 days), and whatever the active rule pack happens to say
*today* — none of which is a document, and one of which actively changes
under the reader's feet.

## Users

- **Risk manager**, defending a termination or a deduction in a dispute:
  needs the PDF a trader can be handed and a CSV for a compliance reviewer to
  reconcile against internal spreadsheets.
- **Trader**, disputing their own account action: needs the same evidence
  the firm has, self-served from the link in their notice, without a
  Supabase session.
- **Compliance / ops**, auditing a whole account's history: needs every
  violation on an account in one export, not one download per violation.

## Requirements

1. A report is a **plain-data snapshot** of one violation or breach decision:
   header, the rule as written, what happened, the arithmetic (as strings
   built from stored numbers, never recomputed), the trade tape, the account
   snapshot at detection time, the action taken, prior history on the
   account, and a provenance block that says what the report cannot honestly
   claim.
2. Renderers (`render-pdf.ts`, `render-csv.ts`) are **pure functions of the
   report object**. Nothing they emit is derived from a live query, a
   generated timestamp, or `Date.now()` — see
   [`violation-report-contract`](../../../docs/agent-skills/violation-report-contract.md)
   for the exact determinism rules.
3. LLM-generated prose, if present, lives only in
   `provenance.generatedNarrative`, carries a fixed disclaimer, and never
   feeds `arithmetic` or any other field a decision is defended on.
4. Every report row is scoped by `tenant_id` with the same RLS shape as every
   other tenant table (`00025_violation_reports.sql`): ENABLE + FORCE, four
   `authenticated` policies, one `service_role` policy.
5. Trader access is token-only: a violation report link resolves through
   `verifyTraderToken`, never a URL parameter, and every failure — wrong
   token, wrong account, nonexistent violation — is an undifferentiated 404,
   so a link cannot be used to enumerate which violation ids exist.
6. Demo mode (`NEXT_PUBLIC_DEMO_MODE=true`) serves the same three formats
   from an in-memory dataset, with no database and nothing persisted.

## The persisted-payload decision, and why

The full assembled report is written once to `violation_reports.report_json`
and read back verbatim on every later request, rather than rebuilt from live
tables on each download. Three facts make "rebuild on demand" actively wrong,
not merely slower:

- `equity_snapshots` are pruned after 7 days
  (`src/lib/ingest/snapshots.ts`); the intraday peak that justified a
  trailing-drawdown breach is gone by the time a dispute reaches week two.
- A rule pack is versioned, but a firm keeps editing its *active* pack's
  thresholds going forward; rebuilding a report tomorrow would silently
  re-state a breach against today's rule instead of the one in force when it
  fired — the single worst thing a decision record can do.
- `accounts.balance` / `.equity` are live columns overwritten on every poll;
  the balance at detection time is not recoverable from them after the fact.

So the report is generated once, hashed (`content_hash`, a sha256 over the
canonical, key-sorted report with `reportId` / `generatedAt` / `generatedBy`
stripped out — a hash of the *facts*, not of one rendering of them), and
reused. Regenerating a report whose underlying facts have not changed is a
no-op that returns the existing row (`unchanged: true` in the API response);
a genuine change in the facts produces a new row rather than overwriting the
old one, so a report already handed to a trader or a processor never changes
under them.

## Determinism

Covered fully in the
[violation-report-contract skill](../../../docs/agent-skills/violation-report-contract.md).
In summary: no `Date.now()` inside a renderer, no LLM in the arithmetic path,
PDF generation timestamps pinned to the report's own `generatedAt` rather
than wall-clock render time, and `schemaVersion` bumped (never mutated in
place) whenever a field's meaning changes, so an old persisted row keeps
rendering under the meaning it was written with.

## Endpoints

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/api/violations/[id]/report?format=pdf\|csv\|json` | GET | risk user (request-scoped client, RLS) | Serves the existing report, building it on first ask. |
| `/api/violations/[id]/report` | POST | risk manager/admin | Regenerates; idempotent by content hash, reports `unchanged`. |
| `/api/violations/account/[accountId]/report` | GET | risk user | One CSV covering every violation on an account; builds any missing reports first (never silently skips undownloaded ones); reports `X-Reports-Built` / `X-Reports-Reused`. |
| `/api/trader/[token]/violations/[id]/report?format=pdf\|csv` | GET | trader token (`tenantDb`, no session) | Tenant and account resolved from the verified token only, never the URL; any failure is a 404. |

## UI placements

- Operator violation detail: PDF/CSV/JSON download actions against
  `/api/violations/[id]/report`.
- Operator account view: a single CSV export against
  `/api/violations/account/[accountId]/report`.
- Trader page (`/a/[token]`): "Full decision record" link per violation,
  served by the trader-token route above — the same numbers the trader's
  headroom view already shows, so the notice and the self-service record
  cannot disagree.

## Trader access

Traders are not tenant members and hold no Supabase session
(`docs/HOW-IT-WORKS.md` §3, "Trader access is a tokenized link, not a
session"). The report route re-verifies the token on every request and scopes
every query to the token's resolved tenant and account via `tenantDb`,
never a path parameter — see the isolation invariant in
[tenant-isolation](../../../docs/agent-skills/tenant-isolation.md).

## Acceptance tests

Covered by `render-pdf.test.ts`, `render-csv.test.ts`, and `build.test.ts`
under `src/lib/reports/violation/`:

- Building the same violation twice without a change in its underlying rows
  returns the same `content_hash` and does not create a second row.
- A changed underlying fact (e.g. a resolved dispute) produces a new row
  with a new content hash, and the old row is left intact.
- PDF and CSV renders of the same report object are byte-for-byte
  deterministic across repeated calls.
- A trader token scoped to account A cannot fetch a report for a violation on
  account B, or on another tenant's account, and both cases return 404
  rather than 403.
- An absent optional field renders as an explicit gap, never a fabricated
  value.
- Demo mode renders all three formats with no `NEXT_PUBLIC_SUPABASE_URL`
  configured.

## Out of scope

- Bulk export across accounts or the whole tenant (only per-violation and
  per-account exports exist).
- Report translation / localization.
- Editing a persisted report; the only mutation path is a full regeneration
  that either reuses or forks by content hash.
- Emailing the report automatically; the trader notice links to it, it is
  not attached.
