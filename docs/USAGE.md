# Using PropRisk day to day

The operator's manual: what each screen is for, what every action writes, and
why the awkward parts are shaped the way they are. Organised by job rather than
by menu, because nobody opens a risk desk thinking "I would like to visit the
enforcement page". Every claim below was read out of `risk-management/src`;
where a feature is demo-only, API-only or partly built, it says so rather than
describing the version somebody meant to ship.

**Try it before you own it.** Most sections end with a demo path — start the app
on mock data and follow along:

```bash
cd risk-management
cp .env.local.example .env.local     # already has NEXT_PUBLIC_DEMO_MODE=true
npm run dev
```

Related reading: [`INSTALL.md`](./INSTALL.md) to get it running,
[`TAILORING.md`](./TAILORING.md) to make it your firm's,
[`REFERENCE.md`](./REFERENCE.md) for the page/route/table inventory,
[`SELF-HOSTING.md`](./SELF-HOSTING.md) for operations, and
[`../risk-management/docs/HOW-IT-WORKS.md`](../risk-management/docs/HOW-IT-WORKS.md)
for the design argument underneath all of it.

**Contents.** [0 Roles](#0-roles-who-can-do-what) ·
[1 The first hour](#1-the-first-hour) · [2 The daily loop](#2-the-daily-loop) ·
[3 Handling a breach](#3-handling-a-breach) · [4 Payouts](#4-payouts) ·
[5 Disputes](#5-disputes) · [6 Trader links](#6-trader-links) ·
[7 The rule-pack lifecycle](#7-the-rule-pack-lifecycle) ·
[8 Reports and exports](#8-reports-and-exports) ·
[9 Fraud hunter, network graph, reviewer](#9-fraud-hunter-network-graph-reviewer) ·
[10 Integrations](#10-integrations) · [11 Operations](#11-operations) ·
[12 Where an LLM is used](#12-where-an-llm-is-and-is-not-used)

---

## 0. Roles: who can do what

A firm is a **tenant**. Every person in it is a row in `tenant_members` with one
of five roles, and the role is minted into the session's `app_metadata`
server-side — never read from `user_metadata`, which the user can edit.

Three guards sit in front of the API and deliberately do not share an allowlist:
`requireTenantAdmin` (`owner`, `admin`) gates invites, the roster, billing and
ingest keys; `requireRiskUser` (`risk_analyst`, `risk_manager`, `admin`) gates
reading the desk; `requireRiskManager` (`risk_manager`, `admin`) gates anything
that changes an account or a rulebook — enforcement, rule-pack writes,
connections, trader links, payouts.

| Role | Roster, invites, billing | Read the desk | Approve enforcement, edit rule packs |
|---|---|---|---|
| `owner` | yes | **no** | **no** |
| `admin` | yes | yes | yes |
| `risk_manager` | no | yes | yes |
| `risk_analyst` | no | yes | no |
| `viewer` | no | **no** | no |

Two of those rows surprise people:

- **`owner` is not a risk-desk role.** The account that created the firm can
  invite teammates and manage billing, and the violations and payouts APIs
  refuse it. Owning the subscription is not the same job as terminating an
  account — but if the same human does both, give them an `admin` seat.
- **`viewer` has no read surface of its own yet.** The role exists in the schema
  and can be invited, but no risk route admits it: the pages render and their
  data calls come back `403`. Treat it as reserved.

Invitable roles are `admin`, `risk_manager`, `risk_analyst` and `viewer`; there
is exactly one `owner`, created at signup. **Demo path:** demo mode bypasses
auth entirely, so every page opens as if you were an `admin` — a property of
the demo, not of the product.

---

## 1. The first hour

The whole onboarding is self-serve, and nothing below enforces anything until
the last step.

### 1.1 Create the firm and invite the team

`/signup` creates the tenant and its owner in one form (`POST
/api/tenancy/signup`, public — it necessarily runs before the caller has a
tenant claim). There is no seeding step and no per-firm deployment: one instance
holds many firms, separated at the database. `POST /api/tenancy/invites` with
`{ email, role }`, as an `owner` or `admin`, then mints a tenant-bound invite;
only the token's hash is stored, and the invitee redeems it at `/accept-invite`.

> **Partial today:** issuing an invite is API-only. `/accept-invite` is the only
> invite screen in the app; there is no roster page yet.

### 1.2 Connect your trading platform

`POST /api/connections` stores one platform's credentials, envelope-encrypted
with a per-tenant key derived from a master key that lives only in the
environment. `POST /api/connections/[provider]/validate` then performs a **real
read** and records `valid` or `invalid` with the error. Do this before you rely
on anything: a key that turns out to be read-only, or scoped to the wrong
account group, should surface during onboarding rather than at 3am.

> **Partial today:** `/connections` is a read-only status board (§10). The
> credential form is not in the UI; use the API. If no connection row exists,
> the provider registry falls back to environment configuration, so a
> single-firm deployment can run on env vars alone.

### 1.3 Pick a preset and tune it

`/rules/new` is a two-step wizard. Step one is the preset picker: seven
firm-shaped starting points, each labelled by the rule **shape** it models —
"Apex-style" describes intraday trailing drawdown that locks at the starting
balance, not an affiliation.

![The preset picker](./screenshots/06-rules-presets.png)

Step two is the tuning form, where one convention matters more than the rest:
**thresholds are shown as percentages and stored as fractions** — type `5` for
5%, not `0.05`. Two schema rules are worth internalising first: **a rule you
omit does not exist** (`enabled: false` is not a generous threshold — modelling
a firm's absent daily loss limit as a very large number produces breach records
that should never have existed), and **`action` is independent of the
threshold** (the same 3% daily loss terminates at one firm and pauses trading at
another). **Save as draft** posts to `POST /api/rulepack`, which validates the
pack, content-hashes it, and versions it per (tenant, pack name) — editing
"House Rules" produces v2 of House Rules rather than an unrelated pack, which is
what makes the version pinned on a breach decision meaningful.

### 1.4 Promote, backtest, activate

On `/rules/[id]`: **Save draft** (`PATCH /api/rulepack/[id]`, drafts only) →
**Promote to testing** (`POST …/promote`; a pack in testing is real and
evaluated but never enforces) → **Backtest tab → Run backtest**
(`POST …/backtest`, pasting the account history to replay as a JSON array of
`EvaluationInput` and, optionally, what your current platform reported for the
same window) → **Activate** (`POST …/activate`, the button appearing only once
the pack is in testing).

The backtest runs the **same** evaluator the live path runs, so no second
implementation can flatter production. Its reconciliation is deliberately
asymmetric (§7): breaches your platform enforced and this pack would have missed
are **blocking**, because activating past them relaxes your own rules.

### 1.5 The staged-launch gate

Anyone can buy; the gate is on **enforcement**. While
`tenants.enforcement_approval_required` is set, activation additionally needs a
platform operator to have read that firm's backtest reconciliation, signed off
per pack *version* with the backtest id recorded alongside. That review runs
through `/api/platform-admin/rule-packs`, gated on `PLATFORM_ADMIN_SECRET` — a
separate secret from `CRON_SECRET`, unreachable by any tenant session, because
the caller is the platform operator rather than a customer. Gating with sales
calls buys less safety than it appears to: a call does not catch a wrong
trailing-drawdown parameter, and a backtest does.

**Demo path.** `/rules` lists three sample packs; open `demo-apex-futures` and
run the backtest without pasting anything.

---

## 2. The daily loop

### 2.1 The morning report

`/risk` → **Generate Risk Report** posts to `/api/reports/morning` and opens the
summary in a modal: pending payouts and their total, accounts flagged, total
deductions, the security flags, the top risk accounts by score, the largest
deductions, and the full report body. The `morning-report` cron runs the same
generation at `0 12 * * *` for every tenant and writes the result to
`morning_reports`, so the number you read at 09:00 has a row behind it rather
than being recomputed differently each time somebody presses the button.

### 2.2 The dashboard

![The risk dashboard](./screenshots/03-risk-dashboard.png)

Top to bottom, `/risk` gives you:

- **Firm-wide exposure** across Forex and Futures together — cross-asset
  concentration is invisible on a single-book dashboard.
- **Payout-liability forecast** — a deterministic p50/p90 projection over 7 and
  30 days from pending payouts, funded-account pipeline and historical rates
  (`src/lib/forecast/liability.ts`). No model, no simulation; the two scenario
  sliders are the assumptions, shown rather than hidden.
- **Summary stats** — pending payouts, total deductions, flagged accounts,
  average payout and deduction, blacklisted — over **Overview / Flagged
  Accounts / All Pending Payouts** tabs carrying the severity distribution,
  violation-type breakdown, payouts by plan and top countries.

Expanding an account row calls `POST /api/payouts/[id]/analyze` for the
deterministic rationale (§4). A **Funded Payouts / Challenges** segment toggle
switches the page between funded and challenge accounts.

### 2.3 Live alerts

![The live breach feed](./screenshots/08-alerts.png)

`/alerts` polls `GET /api/alerts?assetClass=…` every 30 seconds and lists active
breaches newest first: severity, the message, the provider and account, the
rule label, and an **Acknowledge** control.

> **Partial today:** acknowledgement is local to your browser tab — it greys the
> row out and is forgotten on refresh or an asset-class switch, nothing is
> persisted, and no other analyst sees it. The list itself is derived live from
> platform data, so an alert disappears when the underlying condition does, not
> when someone clicks.

### 2.4 The Forex / Futures toggle

The segmented control in the header sets the asset class for **every** dashboard
page: the data hooks append `?assetClass=` and refetch. Not cosmetic — a firm
usually runs different rules on each book (at most one pack is active per tenant
*per asset class*), so "which book am I looking at?" must be answerable at a
glance.

**Demo path.** `/risk` → Generate Risk Report → `/alerts`, flipping the header
toggle.

---

## 3. Handling a breach

### 3.1 What happens before you see anything

The `detect-violations` cron runs every five minutes. Per tenant, futures first
then forex, it loads that tenant's active rule pack, buckets each account's
activity into session days using the firm's own timezone and `day_start`, runs
every enabled primitive whose phase scope matches the account, then persists
each breach to `breach_decisions` pinned to the pack version that produced it —
with an idempotency key over (pack version + account + rule + inputs), so a
re-run is a no-op and a corrected trade tape is genuinely a new decision. It
records a `violations` row (a partial unique index on the same key makes "one
violation per decision" a database guarantee rather than an application
convention), assembles the evidence pack, drafts the trader notice —
**drafted, not sent** — and queues an enforcement recommendation for a human.
Its response body reports what it *persisted*, what was *already recorded*, and
every rule it could **not** evaluate, with the reason. "No breach" and "not
checked" never read the same.

### 3.2 The violation list

![Violations grouped by rule](./screenshots/04-violations.png)

`/violations` groups violations by rule with a count per group, a search box, a
type filter, a date range, **Refresh**, and **Export CSV** for the whole list.
Each row carries **PDF**, **CSV** and **Details**.

### 3.3 One account, every breach

![One account's violation report](./screenshots/05-violation-detail.png)

`/violations/account/[accountId]` is the account-level report: deduction
summary, violation breakdown with the contributing trades and the arithmetic
per rule, the internal analysis summary, and the deduction history from the
platform's own ledger. **Export all (CSV)** downloads every decision record on
the account in one file; **Recheck News** re-runs the economic-calendar
correlation. `/violations/[id]` is the single-violation view: account
information, the violation details, the flagged trades, PDF/CSV, and **Generate
Evidence Pack**, which posts to `/api/evidence` and takes you to the pack it
builds. Two modals there write directly — a manual deduction and a manual email
— so treat them as the exception rather than the flow.

### 3.4 The evidence pack

![An evidence pack](./screenshots/11-evidence-pack.png)

`/evidence/[id]` is the dossier behind a decision, laid out for print: an
executive summary, the account summary, a rule-by-rule scoring trail with each
threshold and what was observed, the deduction math line by line, correlated
news events, network links, prior decisions, and the hash-chained audit entries.
**Export JSON** gives you the pack as data; **Print / Save as PDF** gives you
the document. It is assembled automatically when a breach is recorded — that is
the twenty minutes the product removes, not the judgment.

### 3.5 The enforcement queue

`/enforcement` is where a human decides. Filters for status, escalation level,
violation type and reviewer status; stats across the top; and per row:

- **Approve** — `PATCH /api/enforcement/queue/[id]` with
  `{ decision: "approved", decided_by, notes? }`. Writes `status`, `decided_by`,
  `decided_at` and `decision_notes` on the `enforcement_queue` row; for a
  deduction recommendation it then executes the deduction through the owning
  adapter, and it appends an audit entry naming the approver.
- **Reject** — the same route with `decision: "rejected"`, plus the note.
- **Approve All / Reject All** — select rows and decide them together
  (`POST /api/enforcement/batch`).

Clicking a row opens the detail modal with the recommendation's reasoning,
severity factors and amount breakdown, and the same two buttons. Both actions
require `risk_manager` or `admin`.

> **The queue takes exactly two decisions.** The API accepts `approved` or
> `rejected` and nothing else — there is no "modify" and no manual "escalate"
> button. **Escalation is automatic**: the `enforce` cron every 15 minutes
> raises an untouched item's level on time, volume and amount rules (writing
> `status: 'auto_escalated'` with `escalated_from` and `escalated_at`) and
> expires stale recommendations. To act on a different amount, reject the item
> with a note and execute the deduction you do want from the violation page.

### 3.6 What the trader receives

The notice is drafted from the already-assembled evidence pack by
`src/lib/alerts/notice.ts` — a deterministic formatter, not a model. It quotes
the rule as written, what happened, the arithmetic, the trades, and, when a
trader link has been minted, a "Full decision record" URL. Send it from
`/violations/[id]` or the payout screen; every send is logged at `/email-log`.

The difference this makes is the whole argument for the product. A trader who
reads "peak equity $102,500 − closing equity $96,500 = $6,000 against a $5,000
limit" argues with the market. A trader who reads "your account has been
terminated for a rule violation" opens a chargeback.

### 3.7 PDF or CSV — which to send

Telling a trader why: the **PDF**, one laid-out document with a content hash in
the footer. Handing a processor or a lawyer the tape: the **CSV**, the same
content as filterable rows. Reconciling against your own systems: **JSON**, the
payload the other two render from. "Every breach on this account": the
account-wide CSV. Details in §8.

**Demo path.** `/violations` → PDF on any row → `/violations/account/100185` →
`/evidence/demo-account-100185` → `/enforcement`.

---

## 4. Payouts

Payouts are where cash actually moves, so this is the flow with the most
guardrails. `/payouts` lists pending requests with filters for status,
pre-approval state and search. Expanding a row triggers `POST
/api/payouts/[id]/analyze`, which returns a **deterministic rationale**: the
rules cited, the risk factors, and the arithmetic — requested amount, total
deductions, adjusted amount. The prose may be generated; the numbers never are.
The actions on an expanded payout:

| Action | Route | What it does |
|---|---|---|
| **Risk Check** | `POST /api/payouts/[id]/risk-check` | Re-runs the risk assessment on demand against the active pack, undeducted violations, fraud signals and consistency |
| **IP Check** | `POST /api/payouts/ip-check` | Takes one or more comma-separated addresses and reports VPN / proxy / TOR / datacenter. Rate limited |
| **Pre-Approve / Not Pre-Approved / Reset** | `POST /api/payouts/[id]/preapprove` | Records a reviewer's provisional call and who made it, without paying anything. Rate limited |
| **Approve (Paid)** / **Reject (Not Paid)** | `PATCH /api/payouts/[id]` | The decision, behind a confirmation dialog. `risk_manager` or `admin` only |
| **Send Email** | the payout notice modal | Drafts the notice from the analysis and sends it through the email log |

**Ordering matters and is not negotiable:** the provider call happens *before*
anything is persisted, so a failed platform call can never leave a decision row
claiming a payout that did not happen. The decision, its snapshot and the audit
entry all name the approver.

`/history` is the other half — decided payouts with the risk snapshot each
decision was made on, so "why did we pay this" is answerable months later
without re-deriving it. `POST /api/history/sync` imports payouts decided outside
the platform, keeping the history honest during a migration. **Liability
forecasting lives on `/risk`**, not here: it is a firm-wide number.

**Demo path.** `/payouts`, expand a row, press Risk Check, then `/history`.

---

## 5. Disputes

![Disputes with overturn rate](./screenshots/09-disputes.png)

A dispute is a case against a decision: a breach, a deduction, or a payout.

**Open Dispute** (`POST /api/disputes`) records who raised it and their
statement, and **pins the evidence pack that existed at decision time** —
preferring an existing pack over a fresh build, because a fresh build reflects
today's rule descriptions rather than the ones in force when the trader was
actually breached. A dispute that silently re-scores under a newer pack is
worthless as evidence. A deduction dispute is pinned to its violation's pack.

Transitions (`PATCH /api/disputes/[id]/transition`, `risk_manager` or `admin`):

```
open ──▶ under_review ──▶ upheld | overturned | withdrawn
  └──────────────────────▶ upheld | overturned | withdrawn
```

Terminal states are final — a resolved dispute is the record. Resolving into one
**requires** a written resolution, and every transition appends a hash-chained
audit entry naming the real human from the caller's session, never a hardcoded
actor string.

The **overturn rate per rule** panel across the top is the most useful number
this feature produces: per rule, how often the firm's own resolution reverses
its original decision. Withdrawn cases are excluded — a trader dropping a case
says nothing about whether the rule was right. A rule with a high overturn rate
is wrong, or written ambiguously, and it will keep costing you until it changes.

Below the table, **Decision records for disputed breaches** gives a PDF and CSV
per case. Only `breach` cases appear: payout and deduction disputes are not
violations, and linking them to something that would 404 is worse than leaving
them out.

**Demo path.** `/disputes` — six cases across breach, deduction and payout, with
overturn rates already computed.

---

## 6. Trader links

![The trader's own view](./screenshots/10-trader-view.png)

A trader link is a tokenized, read-only URL showing one trader their own account
against their own firm's rules. Mint one with `POST
/api/accounts/[login]/trader-link` and an optional `{ ttlDays }` (1–365, default
30); `GET` the same route lists them and `DELETE …?id=…` revokes one.

All three require `risk_manager` or `admin` — a link exposes real account state
to whoever holds it, so it is gated like an enforcement action rather than a
read. The response returns the raw token **once**; only its sha256 hash is
stored. Hand out `<NEXT_PUBLIC_APP_URL>/a/<token>`.

> **Partial today:** minting and revoking are API-only. No page in the app has a
> "create trader link" button yet.

What the trader sees, and nothing else: **their drawdown floor** (the number,
plus "Stay above this line. It moves up as your account makes new highs" and
how far above it they are); **a card per other rule** with the limit as
written, where they stand and the headroom left, colour-coded *and* labelled,
because colour alone is never the carrier of a risk signal; **decision
records**, one row per violation with a PDF and a CSV served by `GET
/api/trader/[token]/violations/[id]/report`; and **recent closed trades**.

The page carries no session, has no navigation into the rest of the app, and
reaches exactly one (tenant, account) pair — the token in the URL is the entire
authentication, verified server-side on every request. It is fully
server-rendered with no client JavaScript, so it keeps working on a locked-down
device. Why bother: most disputes are surprise rather than disagreement, and a
trader who watched the floor move all week does not file a chargeback when it
is hit.

**Demo path.** `/a/demo`. Demo mode accepts one fixed token, `demo`, and
resolves it to mock account 500655 without touching a database.

---

## 7. The rule-pack lifecycle

```
draft ──▶ testing ──▶ active ──▶ archived
  │          │            └── archived when its replacement for the
  │          │                same asset class is activated
  │          └── evaluated, never enforcing
  └── the ONLY editable state
```

**A pack that has left draft is immutable.** Editing an active pack would
silently rewrite the rules past decisions were made under, so every change forks
a new version and every breach decision pins the version that produced it. That
is what lets a decision stay explicable years later; a non-draft pack renders as
read-only JSON with exactly that explanation.

**At most one pack is active per tenant per asset class**, enforced by a partial
unique index rather than application code — "which rules applied?" must have
exactly one answer at the moment a trader disputes a termination. Activation
archives the incumbent for that asset class in the same operation.

Four tabs on `/rules/[id]`: **Rules** (the form while draft, JSON afterwards),
**Diff vs active** (a plain-language list of what changed), **Backtest**
(below), and **Impact preview** — which currently-open accounts change status
under this pack. Changing a drawdown from 5% to 4% is one keystroke that can
breach forty funded accounts; nobody should discover that afterwards.

### What the reconciliation means

![Shadow-mode backtest](./screenshots/07-backtest.png)

| List | Meaning | Blocks activation? |
|---|---|---|
| **Agreed** | Your platform and this pack found the same breach | no |
| **Engine found, platform did not report** | This pack caught something your platform did not. Often why a firm is switching — but sometimes a mis-set parameter | no, but a human should look |
| **Platform caught, engine missed** | This pack would have let a breach through that your platform enforced | **yes** |
| **Rules not evaluated** | A rule could not run at all — typically `trailing_intraday` drawdown without intraday equity snapshots | see the caveat below |

`activate()` refuses when there is no completed backtest, when the last one
found any breach in the "platform caught, engine missed" list, when the tenant
is gated and the version has no platform sign-off, or when the pack is archived.

> **Read this before you trust the verdict.** The backtest reads **Not safe to
> activate** when any rule was skipped, and that is the right reading — a run
> that could not evaluate a rule did not prove coverage. But `activate()`
> currently blocks only on the "platform caught, engine missed" list, so a pack
> whose main rule was never evaluated can still be activated. Treat the verdict
> banner as the gate, and resolve the missing inputs (§10) first.

**Demo path.** `/rules/demo-apex-futures` → Backtest → Run backtest. Six
accounts, one engine breach, zero platform-only, one rule reported skipped with
its reason, verdict *Not safe to activate*.

---

## 8. Reports and exports

| What | How | Notes |
|---|---|---|
| One violation, as a document | `GET /api/violations/[id]/report?format=pdf` | The **PDF** button on `/violations`, `/violations/[id]`, `/violations/account/[id]`, `/disputes` |
| One violation, as rows | `…?format=csv` | The **CSV** button in the same places |
| One violation, as data | `…?format=json` | The payload the other two render from — what makes them auditable |
| Regenerate one | `POST /api/violations/[id]/report` | `risk_manager`/`admin`. Explicit, never a side effect of a `GET`, so nobody changes a document a trader is holding by refreshing a page |
| Every violation on an account | `GET /api/violations/account/[accountId]/report` | **Export all (CSV)** |
| The whole filtered list | **Export CSV** on `/violations` | A working file, not a decision record |
| The morning summary | `POST /api/reports/morning`, or the `morning-report` cron | Persisted to `morning_reports` |
| An evidence pack | **Export JSON** / **Print / Save as PDF** on `/evidence/[id]` | |
| A trader's own copy | `GET /api/trader/[token]/violations/[id]/report` | Same content, scoped to their account |

### What "deterministic" means here, and why it matters

![A generated violation report](./screenshots/13-violation-report-pdf.png)

The report is rendered from a **persisted, content-hashed payload** in
`violation_reports`, not recomputed from live data on each request. Two
downloads a month apart are the same document, and the hash in the footer says
so — a trader disputing a report must not find it changed while the account
kept trading.

Two rules the builder does not bend (`src/lib/reports/violation/build.ts`):

1. **No LLM contributes a figure.** Every arithmetic line is a deterministic
   string built from stored numbers. Where generated prose exists — an evidence
   pack's executive narrative — it is copied into
   `provenance.generatedNarrative` behind the disclaimer *"Generated prose
   describing the decision; not part of the decision."*
2. **The rule is quoted, not recomputed.** The limit, the observation and the
   arithmetic come from the evidence the evaluator wrote **at decision time**;
   re-deriving them from today's pack would re-state an old breach against a
   rule that has since moved.

The report carries its own provenance too: which rows it was built from (breach
decision, evidence pack, enforcement queue), its audit-chain entry, and any
recorded limits on the fidelity of the underlying data.

**Demo path.** `GET /api/violations/100185-grid/report?format=pdf` returns a
real two-page PDF; the same id with `format=json` shows what it was built from.

---

## 9. Fraud hunter, network graph, reviewer

Three background analyses. None enforces anything — each produces findings a
human reads.

### Fraud hunter

Five detectors, all tenant-scoped with no cross-tenant correlation: copy rings,
shared identity, coordinated payouts, account churning, profit manipulation.
The `fraud-hunter` cron runs them every 15 minutes and writes to
`fraud_investigations`; `POST /api/fraud-hunter/scan` triggers a manual scan
(rate limited).

> **Partial today:** there is no page for this. A findings panel exists in the
> codebase but no route renders it, so findings are read through
> `GET /api/fraud-hunter/investigations` and
> `GET|PATCH /api/fraud-hunter/investigations/[id]`, or through the `/ai` chat.
> The scan itself runs and persists.

This is also the system's most instructive scar: the scan once reported success
for months while silently discarding every finding, because a unique index had
moved beneath it. Everything here now reports what it *persisted*.

### Network graph

`/network` renders the live cluster graph for the selected asset class — copy
rings, shared identity and coordinated payouts, including cross-asset links
invisible on a single-book dashboard — with clusters found, accounts involved,
exposure at risk split by book, node and edge counts, and a selectable cluster.

### Reviewer

The `reviewer` cron runs at 02:30 Monday to Saturday and reconciles the
deductions this system approved against the platform's own account metrics and
ledger events, matching type and amount within a cent; `/reviewer` shows the run
history. "We deducted it" and "the platform deducted it" are different claims,
and only one of them is money.

---

## 10. Integrations

![The integrations board](./screenshots/12-connections.png)

`/connections` is the read-only status board for all ten adapters, grouped by
asset class. Each card shows the transport, accounts carried, access model
(**firm-wide** or **per-trader** — a per-trader API means firm-wide monitoring
needs a key per trader, worth confirming before you start), risk model
(**native** violations from the platform, or **computed** here), enforcement
support, a status of `Live` / `Demo` / `Not Configured`, and a link to that
platform's API docs.

**Live:** MatchTrader (forex), Tradovate (futures). **Stubs:** DXtrade,
TradeLocker, cTrader, MetaTrader 4/5, Rithmic, TopstepX (ProjectX), CQG,
NinjaTrader — each throwing rather than returning an empty list, naming what to
set. That distinction is not pedantry: an empty list reads as "no breaches".

**Credentials** go in through the API (§1.2), envelope-encrypted with a
per-tenant key. If a tenant has no connection row the registry falls back to
environment configuration, so a single-firm deployment runs on env vars alone
and a new tenant is not hard-broken before filling anything in.

**Equity snapshots.** `trailing_intraday` drawdown and `highest_equity_of_day`
daily loss cannot be computed from closed trades — the peak happens while a
position is open and never reaches the tape. Supply samples either by **push**
(`POST /api/ingest/equity-snapshots` with a per-tenant key minted at `POST
/api/ingest/keys`) or by **poll** (the `sample-equity` cron, every five
minutes). The sampling interval is stored alongside each sample, so a breach
derived from sparse data can say so. Without snapshots those rules report
`skipped` with a reason — never a pass, and never a quiet downgrade to the more
forgiving end-of-day model.

Finishing a stub adapter is documented in [`TAILORING.md`](./TAILORING.md) §4.

---

## 11. Operations

### The scheduled jobs

Every `/api/cron/*` route requires `Authorization: Bearer $CRON_SECRET`, checked
in `middleware.ts` **and** again in the handler, and enforced even in demo mode.
Each fans out per tenant at bounded concurrency, isolates per-tenant failure,
and reports one outcome per tenant in its response body.

| Job | Schedule | What it writes |
|---|---|---|
| `ingest-trades` | `* * * * *` | `accounts`, `trades` |
| `detect-violations` | `*/5 * * * *` | `breach_decisions`, `violations`, `evidence_packs`, `enforcement_queue`; reports every rule it could not evaluate |
| `process-violations` | `* * * * *` | Drains the per-tenant violation queue (Redis); no-op when the queue is not configured |
| `sample-equity` | `*/5 * * * *` | `equity_snapshots`, with the sampling interval |
| `fraud-hunter` | `*/15 * * * *` | `fraud_investigations` |
| `enforce` | `*/15 * * * *` | Escalates and expires stale `enforcement_queue` items |
| `reviewer` | `30 2 * * 1-6` | `reviewer_runs` |
| `morning-report` | `0 12 * * *` | `morning_reports` |
| `sync-news` | `0 6 * * 1` | `news_events` (global — the economic calendar is the same for every firm) |

The schedules live in `risk-management/vercel.json`. On any other host, point an
external scheduler at the same paths with the same header; there is a ready-made
crontab in [`SELF-HOSTING.md`](./SELF-HOSTING.md) §5.

### Health

`GET /api/health` is public and returns the environment, Supabase and Redis
probes with their latency. In demo mode it returns `{"status":"healthy",
"demo":true}` with no probes, because there is nothing to probe.

### The two isolation checks

Run **both** after any migration or any change under `src/lib/db/`,
`src/lib/auth/` or a tenant-scoped query. They answer different questions:

```bash
# Does isolation hold? Builds a real Postgres 17 on port 55432 from the full
# migration chain and tries to read, write and delete across the boundary.
bash risk-management/supabase/tests/verify-isolation.sh

# Will it still hold tomorrow? Fails the build on the four edits that
# historically erode it. This one runs in CI.
node risk-management/scripts/check-isolation.mjs
```

Isolation does not fail in one dramatic commit; it decays through ordinary
Friday-afternoon changes. That is why the guard exists as well as the suite.

### Secrets and backups

Rotation (including `CONNECTIONS_MASTER_KEY`, which needs a key-version bump
alongside), backups and the upgrade path are in
[`SELF-HOSTING.md`](./SELF-HOSTING.md) §§7–9. Two habits worth naming here:
`CRON_SECRET` and `PLATFORM_ADMIN_SECRET` must be different values, because
leaking one must not grant the other; and the master key never goes in the
database, which is what makes a leaked `connections` row useless.

**Demo path.** `curl localhost:3000/api/health`.

---

## 12. Where an LLM is, and is not, used

The line is one sentence: **a model may describe a decision, never make one.**

| Good | Forbidden |
|---|---|
| drafting a rule pack from an uploaded rulebook (human approves) | deciding whether a breach occurred |
| writing the prose of a trader notice from deterministic evidence | recomputing a deduction |
| summarising a dispute for support | choosing an enforcement action |
| explaining what changed between pack v1 and v2 | interpreting an ambiguous rule live |

In this codebase the model is reached from exactly three places
(`src/lib/ai/claude.ts`): the **executive narrative** on an evidence pack,
prose over findings already computed; the **explanation** attached to a payout
decision, where the numbers come from `src/lib/payouts/decision.ts` and the
sentence around them does not; and **intent classification** for the `/ai`
analytics chat, and only as a fallback — the parser is regex-first, and every
answer is formatted from a deterministic query against the firm's own data.

Everything else people assume is generated is not. The trader notice is a
template over the evidence pack, the morning report is arithmetic, and the risk
score, the liability forecast and every figure in a violation report are
deterministic functions of stored rows. In demo mode the client throws before it
even reads a key: a demo deployment cannot spend API credits even if
`ANTHROPIC_API_KEY` is set.
