# Build spec — PropRisk

A specification complete enough that an agent with **no access to this
repository** can build an equivalent system, and precise enough that an agent
which *does* have the repository can check itself against the reference
implementation at every step.

---

## 0. Purpose, and how to use this spec

### If you are a human

Read §1 and §6. They contain the reasoning; everything else is consequence. Then
read [`../risk-management/docs/HOW-IT-WORKS.md`](../risk-management/docs/HOW-IT-WORKS.md),
which is the design argument this spec was extracted from.

### If you are an agent

1. Read this whole file before writing a line. It is long because the domain has
   sharp edges, and every one of them below was found the expensive way. If you
   have the repository, also load the matching file under
   [`agent-skills/`](./agent-skills/) before touching tenant isolation, RLS,
   rule packs, or violation reports — each spells out the invariant, the
   procedure, and the exact verification command for that area.
2. Work the milestones in §11 **in order**. Each states a goal, its
   deliverables, and a fenced verification command whose expected output is
   given. A milestone is done when its command prints what §11 says it prints —
   not when the code looks right, not when the types check.
3. Paste the real output of every verification command into your report. If a
   command fails, fix the code, not the command.
4. When this spec and the reference implementation disagree, the reference
   implementation is right and the spec has a bug: say so in your report rather
   than quietly following one of them.
5. **Stop and ask** on any ambiguity about a firm's actual trading rules. A
   guessed threshold terminates real funded accounts. There is no version of
   "reasonable default" that is safe here.

### Conventions in this document

- `reference:` marks the path in this repository that implements the thing being
  described. Ignore those lines if you are building from scratch.
- Percentages in rule packs are **fractions**: `0.05` is 5%. Mixing the two
  conventions is the classic 100x error in this domain.
- "Session day" never means "UTC calendar date". See §4.6.

---

## 1. Product thesis and the non-negotiable invariants

### 1.1 What is being built

Not a detector. Every prop firm already has one: their trading platform computes
drawdown in real time and auto-liquidates. Building a second, worse detector and
selling it as risk management is the standard mistake in this category.

What no firm has is a **system of record for risk decisions** — one place where
the rules are written down once, applied identically to every account, and where
every breach and every payout leaves behind an artifact that can be handed to a
disputing trader, a payment processor, or a regulator.

The detector is table stakes. The decision, its evidence and the audit trail are
the product.

### 1.2 The invariants

These are not preferences. A build that violates any of them is not this system,
however good it looks. Each is stated with the failure it prevents, because a
rule whose reason is unknown gets relaxed by the next person.

**I1 — The engine is deterministic.**
The same inputs against the same pack version produce the same decisions, every
time. No model output, no wall-clock dependency, no randomness, no I/O inside
evaluation. *Because:* "we cannot reproduce why we terminated your account" is
the end of a dispute you lose.

**I2 — Idempotent by input, not by clock.**
Every decision carries a key derived from (pack version, account, rule, inputs).
Re-running a job is a no-op; a corrected trade tape or a new pack version is
genuinely a new decision. *Because:* a time-window dedup returns different
answers depending on when the job happened to fire, which makes replay
impossible.

**I3 — `skipped` is never a pass.**
A rule the engine could not evaluate is reported with a reason. It never silently
becomes "no breach", and a backtest containing any skipped rule cannot certify
coverage. *Because:* "no breach" and "not checked" reading the same is how a
platform assures a customer of coverage it does not have.

**I4 — A human approves every enforcement action.**
Evidence is assembled automatically and the trader notice is drafted
automatically; neither is sent, and no action reaches the trading platform,
without a named person approving it. *Because:* a firm's risk team must remain
the author of its own decisions, and an audit trail must be able to name
someone.

**I5 — A model may describe a decision, never make one.**
Acceptable: drafting a rule pack from an uploaded rulebook for a human to
approve, writing the prose of a notice from deterministic evidence, summarising a
dispute, explaining what changed between two pack versions. Forbidden: deciding
whether a breach occurred, recomputing a deduction, choosing an enforcement
action, interpreting an ambiguous rule live.

**I6 — Isolation is enforced five times over, and verified by machine.**
See §7. *Because:* isolation does not fail in one dramatic commit; it decays
through ordinary Friday-afternoon edits, and any single mechanism is defeated by
one of them.

**I7 — Rule packs are immutable once they leave draft, and versioned.**
Editing an active pack would rewrite the rules that past decisions were made
under. A change forks a new version; every decision pins the version that
produced it; at most one pack is active per (tenant, asset class), enforced by a
database constraint rather than by application code.

**I8 — Provider call before persist, on anything that moves money.**
The trading-platform call happens first; the decision row is written after it
succeeds. *Because:* the reverse ordering leaves a row claiming a payout that
never happened.

**I9 — Every job reports what it persisted, not what it attempted.**
A cron that scans nothing must say so. A rule that could not run must appear in
the response. *Because:* the characteristic failure of this kind of system is not
a crash; it is a scan that reports success while silently discarding every
finding.

**I10 — Nothing tenant-authored is ever executed.**
Firms configure parameters from a closed catalog. There is no expression
language, no user-supplied predicate, no `eval`. A pack is data, validated
against a schema, content-hashed.

---

## 2. Stack and constraints

| Concern | Choice | Why it is this, and where you may substitute |
|---|---|---|
| Framework | Next.js 14, App Router | Server components mean the operator console reads the database directly without an API layer for display-only data. Any full-stack framework with server rendering and route handlers works. |
| Language | TypeScript, `strict: true` | The rule pack is a discriminated union; strictness is what stops an unhandled variant reaching production. Non-negotiable if you keep the schema shape. |
| Styling | Tailwind 3.4 | See §10. The visual contract is a separate document. |
| Database | Supabase (Postgres + auth) | Row-level security is the second isolation layer and the auth system mints the tenant claim. **Substitutable only for another Postgres with RLS**; dropping RLS removes a layer the whole model depends on. |
| Validation | zod | Every route body and every rule pack. |
| Charts | Recharts | Display only. |
| Tests | vitest | Golden vectors for the engine; unit tests everywhere else. |
| Rate limiting | Upstash Redis, optional | In-memory fallback when unset. Keys are namespaced per tenant. |
| Billing | Stripe, optional | Checkout, portal, signature-verified webhook. |
| Email | Resend, Gmail fallback, optional | Notices and support. |
| PDF | pdfkit | Deterministic rendering; see §9. |
| CSV | `csv-stringify` behind one shared writer | RFC 4180, one implementation. |
| Runtime | Node 20+ | |
| Hosting | Vercel, or any Node host | Nine cron schedules live in `vercel.json`; off Vercel, any scheduler that can send an authenticated GET works. |

**Constraints that shape the design:**

- **No per-firm deployment.** One deployment serves every firm, because a
  per-firm deployment cannot be created by someone filling in a signup form, and
  self-serve onboarding is the whole thesis.
- **No realtime feed required.** The system must work on polling, and must be
  honest about which rules polling cannot evaluate (§4.3).
- **Optional dependencies must be genuinely optional.** With only Supabase
  configured the app runs: no Redis, no Stripe, no email, no provider.
- **Demo mode with zero backend.** A single flag makes every API return coherent
  mock data, so the whole product can be evaluated before anyone signs up.

---

## 3. Data model

### 3.1 Shape of every tenant-scoped table

Every table holding customer data carries the same four things. Copy this block
verbatim for each new table — it is the exact shape used throughout, and
deviating from it by one clause is how a hole opens.

```sql
CREATE TABLE IF NOT EXISTS <table> (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- ... columns ...
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every tenant-scoped query filters on tenant_id, so it leads every index.
CREATE INDEX IF NOT EXISTS idx_<table>_tenant ON <table>(tenant_id, created_at DESC);

ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
-- FORCE matters: the table owner bypasses RLS otherwise, and migrations run as owner.
ALTER TABLE <table> FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_select_<table> ON <table>
  FOR SELECT TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY tenant_insert_<table> ON <table>
  FOR INSERT TO authenticated WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_update_<table> ON <table>
  FOR UPDATE TO authenticated
  USING (tenant_id = auth_tenant_id()) WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_delete_<table> ON <table>
  FOR DELETE TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY service_all_<table> ON <table>
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

`reference: risk-management/supabase/migrations/00023_disputes.sql`

Two clauses carry the weight:

- **`WITH CHECK` on UPDATE** is what stops a row being *moved* into another
  tenant. A `USING`-only policy permits exactly that, and looks correct.
- **`FORCE ROW LEVEL SECURITY`**, because migrations run as the table owner and
  owners bypass RLS without it.

### 3.2 The claim function

```sql
-- SECURITY INVOKER (the default) is mandatory. A SECURITY DEFINER helper would
-- evaluate with the definer's rights and could be used to escape the very
-- policies it feeds.
--
-- A NULL return DENIES rather than permits: `tenant_id = NULL` evaluates to
-- NULL, which is not TRUE, so every policy fails closed. A token with no tenant
-- claim therefore sees nothing at all.
CREATE OR REPLACE FUNCTION auth_tenant_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(
    COALESCE(
      current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'tenant_id',
      ''
    ),
    ''
  )::uuid
$$;

CREATE OR REPLACE FUNCTION auth_tenant_role()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role',
    ''
  )
$$;
```

Read from `app_metadata`, never `user_metadata` — the latter is writable by the
user through the auth client, so authorization read from it lets any signed-in
user promote themselves.

### 3.3 Column privileges on the tenant row

RLS is row-level: it decides *which rows* you may write, never *which columns*.
A policy letting a firm's own admin update their own tenant row therefore lets
them set their own plan tier, lift their own account ceiling, reactivate a
cancelled tenant, and clear their own enforcement gate.

```sql
-- Allowlisted rather than denylisted: a column added later is NOT
-- customer-writable by default, so the next person to add `billing_override`
-- does not have to remember this file.
REVOKE UPDATE ON tenants FROM authenticated;
GRANT  UPDATE (name, branding_json) ON tenants TO authenticated;
```

`reference: risk-management/supabase/migrations/00020_enforcement_approval.sql`

### 3.4 Global tables

Four tables are deliberately not tenant-scoped. The list is duplicated in the
application's scoped data-access layer and in the CI isolation guard, each entry
with its reason, so making something global is an act somebody signed:

| Table | Reason |
|---|---|
| `news_events` | The economic calendar is identical for every firm |
| `tenants` | The tenant registry itself |
| `tenant_members` | Its `tenant_id` is the foreign key, not a scope |
| `tenant_invites` | Same |

Everything else is tenant-scoped. When you add a table, add the column, copy the
RLS block, lead the index with `tenant_id`, and scope any UNIQUE constraint keyed
on a provider-issued value — two firms routinely hold the same account login,
and a globally unique constraint makes the second firm's insert fail.

### 3.5 The tables

Grouped by what they are for. Columns listed are the load-bearing ones; the
housekeeping columns from §3.1 are on all of them.

**Tenancy and access**

| Table | Key columns | Purpose |
|---|---|---|
| `tenants` | `name`, `slug` unique, `plan_tier`, `status`, `branding_json`, `max_accounts`, `enforcement_approval_required` | One prop firm. The unit of isolation and billing. The last four columns are column-privilege-protected (§3.3). `enforcement_approval_required` defaults **true**, so a tenant created by a future code path that has never heard of the column is gated rather than ungated. |
| `tenant_members` | `user_id`, `role` in (`owner`,`admin`,`risk_manager`,`risk_analyst`,`viewer`), unique on (`tenant_id`,`user_id`) | Membership with a role. The source of truth the JWT claim is minted from. |
| `tenant_invites` | `email`, `role`, `token_hash` unique, `expires_at`, `accepted_at` | Bound to the issuing tenant; cannot be redeemed into another. Only the hash is stored. |
| `trader_access_tokens` | `account_id`, `token_hash`, `expires_at`, `revoked_at`, `last_viewed_at` | Tokenized trader links. Only the sha256 hash is persisted; the raw token exists only in the link handed to the trader. |
| `ingest_keys` | `key_hash` unique, `label`, `revoked_at`, `last_used_at` | Per-tenant keys for pushing equity snapshots. |
| `connections` | `provider_id`, `asset_class`, `enabled`, `api_url`, `encrypted_secrets`, `key_version`, `status` in (`unvalidated`,`valid`,`invalid`), `last_validated_at`, `last_error` | Per-tenant platform credentials, envelope-encrypted (§5.3). |

**The rule-pack engine**

| Table | Key columns | Purpose |
|---|---|---|
| `rule_packs` | `name`, `asset_class`, `version`, `status` in (`draft`,`testing`,`active`,`archived`), `schema_version`, `pack_json`, `content_hash`, `derived_from`, `approved_by`/`approved_at`, `effective_from`, `platform_approved_by`/`_at`/`_note`/`_backtest_id` | Versions are per (tenant, name). A **partial unique index on (`tenant_id`,`asset_class`) WHERE `status` = 'active'** enforces at most one active pack, so "which rules applied?" has exactly one answer at the moment a trader disputes a termination. |
| `breach_decisions` | `rule_pack_id`, `rule_pack_version`, `account_id`, `rule_id`, `action`, `exceeded_by`, `session_day`, `evidence_json`, `enforced`, `idempotency_key` | One decision. `enforced` is false for shadow-mode runs. Unique on (`tenant_id`, `idempotency_key`, `enforced`) — `enforced` is part of the key so a shadow-mode decision and the live decision for the same inputs can coexist without either overwriting the other. |
| `backtest_runs` | `rule_pack_id`, `rule_pack_version`, `status` in (`running`,`complete`,`failed`), `reconciliation_json` | Shadow-mode runs; the reconciliation is what activation reads. |

**Accounts, trades and breaches**

| Table | Purpose |
|---|---|
| `accounts` | Local account state: login, starting balance, balance, equity, phase, restriction flags |
| `trades` | Trade history pulled from the firm's platform |
| `violations` | Detected violations, linked to their enforcement item |
| `violation_reports` | The persisted report payload behind every PDF and CSV (§9) |
| `deductions` | Executed balance adjustments |
| `equity_snapshots` | `captured_at`, `balance`, `equity`, `open_pnl`, `source` in (`poll`,`push`), `sample_interval_seconds` — the interval is stored **with** the data so a breach derived from sparse samples can say so |
| `account_snapshots`, `account_violation_history`, `challenge_violation_cache`, `challenge_sync_progress` | Cached state and repeat-offender tracking |

**Decisions, evidence and disputes**

| Table | Purpose |
|---|---|
| `audit_log` | Append-only, SHA-256 hash-chained. Each entry hashes (action, entity, actor, canonicalised details, previous hash, timestamp) |
| `evidence_packs` | The assembled dossier behind a decision |
| `payout_decisions` | Explainable payout decisions: cited rules, the arithmetic, the approver, the audit hash |
| `payout_history` | Full payout snapshots, pending through decided |
| `enforcement_queue` | Recommendations awaiting human approval, with severity score, escalation level and expiry |
| `disputes` | `subject_type` in (`breach`,`payout`,`deduction`), `subject_id`, `trader_statement`, `status` in (`open`,`under_review`,`upheld`,`overturned`,`withdrawn`), `evidence_pack_id`, `audit_hash` |
| `reviewer_runs`, `fraud_investigations` | Nightly verification history; cross-account findings |

**Risk engine, billing, reporting**

`risk_profiles`, `risk_pretrade_decisions`, `risk_trade_events`,
`risk_violations`, `risk_alerts`, `risk_session_reports`, `subscriptions`,
`usage_snapshots`, `morning_reports`, `emails`, `support_tickets`.

### 3.6 Migration discipline

- **Migrations only append.** `00001` is the consolidated baseline; tenancy and
  RLS arrive in `00015`; every later file adds. Never edit a migration that has
  been applied anywhere.
- **`00015` drops every policy on every tenant table before recreating them.**
  Policies are OR-ed, so one permissive leftover defeats all of the new ones.
- **Generate the policies in a loop from one canonical table list**, not by hand.
  A hand-written list of 88 policies is a list with a typo in it, and a typo here
  is a data leak.

---

## 4. The rule-pack contract

### 4.1 Why parameters, not code

Firms do not differ in **kind**. They differ in **parameters**. Apex trails
drawdown intraday; TopStep trails it end-of-day and locks it at the starting
balance; FTMO does not trail at all. That is one primitive with three parameter
sets, not three features — and the observation generalises, because firms copy
each other's risk model and adjust a number.

So the catalog is **closed** and the parameters are **open**. No firm ever
supplies code, nothing tenant-authored is executed, and every pack is
schema-validated, versioned, content-hashed and immutable once it leaves draft.

### 4.2 Three load-bearing properties

Each of these was derived from how real firms differ, and each would have been
missed by designing from imagination:

1. **`enabled: false` means the rule does not exist**, not that its threshold is
   generous. Lucid's funded product has no daily loss limit and no consistency
   rule at all. Modelling those as very large numbers produces breach records
   that should never exist. Omission and `enabled: false` mean the same thing.
2. **`action` is independent of the threshold.** The5ers Pro Growth *terminates*
   on a 3% daily loss; TopStep *pauses trading* on its equivalent. Same rule,
   same basis, different consequence.
3. **Rules are scoped by account phase.** Tradeify enforces a 40% consistency
   rule during evaluation and drops it once funded. A rule that is
   unconditionally on is wrong for most of the market.

One more, easy to get wrong: **asset class does not imply drawdown mode.**
Futures firms cluster on trailing and forex on static, but The5ers runs a
trailing model on a forex product — so `asset_class` is descriptive only, and the
two stay independent parameters.

### 4.3 The schema

```ts
type AccountPhase = 'challenge' | 'verification' | 'funded';
type BreachAction = 'terminate' | 'pause_trading' | 'flag_for_review' | 'warn';

// pct_* values are FRACTIONS (0.05 = 5%). The schema refuses anything above 1
// rather than trusting the caller to have picked the same convention.
type Threshold =
  | { type: 'pct_of_initial'; value: number }   // 0 < v <= 1, of starting balance
  | { type: 'pct_of_current';  value: number }  // 0 < v <= 1, of current balance
  | { type: 'fixed';           value: number }; // absolute currency, > 0

interface SessionConfig {
  timezone: string;    // IANA, validated at parse time
  day_start: string;   // 'HH:MM'. '00:00' means plain calendar days
  week_start: 'sunday' | 'monday';
}

interface RuleBase {
  enabled: boolean;
  applies_to_phases: AccountPhase[];   // min 1; defaults to all three
  action: BreachAction;                // defaults to 'flag_for_review'
}

interface RulePack {
  schema_version: 1;
  asset_class: 'forex' | 'futures';    // descriptive only
  name: string;
  session: SessionConfig;
  rules: Partial<Record<RuleId, Rule>>; // every rule optional
}
```

`reference: risk-management/src/lib/rulepack/schema.ts`

### 4.4 The thirteen primitives

For each: what it takes, what it computes, and the edge case that will bite you.

---

**1. `daily_loss`** — the day's loss against a limit.

- Parameters: `basis` (`balance` | `equity` | `highest_equity_of_day`),
  `include_open_pnl`, `threshold`.
- Maths: bucket activity into session days (§4.6); for each day compute the loss
  against the chosen basis; breach when it exceeds the resolved threshold.
- `balance` is realised only — the basis FTMO measures from the prior close.
  `equity` includes open positions. `highest_equity_of_day` measures from the
  intraday high-water mark and is the harshest basis in common use.
- **Edge case:** `highest_equity_of_day` cannot be computed from the closed-trade
  tape, because the peak may occur while a position is open. With no equity
  snapshots the rule reports `skipped` with a reason. It must never fall back to
  a laxer basis.

**2. `drawdown`** — the floor beneath the account.

- Parameters: `mode` (`static` | `trailing_intraday` | `trailing_eod`), `lock`
  (`never` | `at_initial_balance` | `at_initial_plus`), `lock_buffer`, `basis`,
  `threshold`.
- Maths: `static` fixes the floor at open, `trailing_intraday` raises it on every
  new equity high, `trailing_eod` raises it on the day's close. `lock` is where a
  trailing floor stops trailing — TopStep's stops permanently once it reaches the
  starting balance, which is what makes a funded account safe to hold. Without a
  lock, a profitable account is never further from breach than a new one.
- **Edge cases:** `lock_buffer` is required when `lock` is `at_initial_plus`.
  `lock` must be `never` when `mode` is `static` — a static floor does not trail,
  so a lock on it is a misunderstanding, and silently ignoring it hides the
  misunderstanding. `trailing_intraday` without snapshots is `skipped`, never
  downgraded to `trailing_eod`.

**3. `consistency`** — a cap on any single day's share of total profit.

- Parameters: `max_best_day_pct_of_profit`, `evaluated_at` (`payout` |
  `continuous`), `min_profit_to_evaluate`.
- Maths: best session day's profit ÷ total profit; breach above the cap.
- **Edge case:** evaluated continuously, this breaches on day one of any
  profitable account, because one day is 100% of the profit so far. The schema
  therefore requires `min_profit_to_evaluate > 0` whenever `evaluated_at` is
  `continuous`. Most firms test it only at payout.

**4. `min_trading_days`** — a floor on activity.

- Parameters: `min_days`, `count_basis` (`any_trade` | `profitable`).
- **Edge case:** The5ers requires 3 *profitable* days; most firms count any day
  traded. Counting the wrong one passes accounts that should not pass.

**5. `inactivity`** — maximum idle days.

- Parameters: `max_idle_days`. Measured in session days since the last trade.

**6. `position_limit`** — a ceiling on concurrent size.

- Parameters: `mode` (`by_account_size` | `fixed`), `fixed_limit`,
  `limits_by_size` (starting balance → max size), `per_symbol_class`.
- **Edge case:** an account size absent from `limits_by_size` must be an authoring
  error, not a silent default. An earlier engine fell back to `|| 10` contracts,
  so unlisted sizes were policed against a number nobody chose.

**7. `overnight_holding`** and **8. `weekend_holding`** — positions still open at
a wall-clock time in the session timezone breach.

- Parameters: `flat_by` (`HH:MM`).
- **Edge case:** the comparison is in the session's zone, not UTC, and not the
  server's zone.

**9. `news`** — a blackout window around economic events.

- Parameters: `before_minutes`, `after_minutes`, `impact_levels`
  (`red`/`orange`/`yellow`), `applies_to` (`related_currency` |
  `all_instruments`).
- **Edge case:** without a calendar feed the rule is `skipped`. A heuristic
  ("trades near the top of the hour") may nominate candidates but must never
  produce a breach on its own — every violation is confirmed against a real
  event.

**10. `hft`** — sliding-window trade-rate limits.

- Parameters: `windows[]` of `{ window_seconds, max_trades }`. More than
  `max_trades` inside any window breaches.
- **Edge case:** partial closes are one position, not several trades. Group by
  position id before counting or every scaled exit reads as high-frequency
  trading.

**11. `martingale`** — size escalation after losses.

- Parameters: `min_losing_streak`, `volume_multiplier` (> 1).
- Maths: after a run of `min_losing_streak` losses, a trade whose size exceeds
  the previous by `volume_multiplier` breaches.

**12. `grid`** and **13. `copy_trading`** — cross-account patterns.

- Parameters: window, lot-size tolerance, minimum matched trades, score
  threshold.
- **These are not evaluated per account.** They compare one account against every
  other, which is a different shape of computation and one that must be
  partitioned by tenant — an unpartitioned ring scan surfaces one firm's trading
  patterns inside another firm's alerts, a leak that never touches a row the
  reader was forbidden to read. The per-account evaluator reports them as
  `skipped` with that reason, and a separate per-tenant pass computes them.

### 4.5 Semantic validation

A JSON schema cannot express these. Each must be an error at authoring time,
because each would otherwise reach production looking valid:

```
- A pack must enable at least one rule.
- drawdown.lock_buffer required when lock = 'at_initial_plus'.
- drawdown.lock must be 'never' when mode = 'static'.
- position_limit.fixed_limit required when mode = 'fixed'.
- position_limit.limits_by_size required and non-empty when mode = 'by_account_size'.
- daily_loss threshold must not exceed the drawdown threshold of the same type —
  the drawdown rule would always breach first, making the daily loss rule
  unreachable.
- consistency.min_profit_to_evaluate must be > 0 when evaluated_at = 'continuous'.
- applies_to_phases must name at least one phase on any enabled rule.
```

`reference: validateRulePack() in risk-management/src/lib/rulepack/schema.ts`

### 4.6 Session days

A "day" is a firm-defined window, not a UTC calendar date. The CME session for
Monday opens at 17:00 ET on **Sunday**, so a trade at 18:00 Sunday belongs to
Monday's daily-loss bucket.

```
A session labelled D runs from day_start on D-1 through day_start on D.
So an instant at or after day_start belongs to the NEXT calendar date's session.
day_start of '00:00' means plain calendar days and the shift is skipped —
without that special case every forex account's history is displaced by one day.
```

Implement with `Intl.DateTimeFormat` and an IANA zone rather than a date library:
the timezone database ships with the runtime, so DST is handled by the platform
and there is no dependency to drift. Anchor any ±1 day step at noon UTC so a DST
shift cannot swallow it.

Getting this wrong silently attributes losses to the wrong day, splits one
session's losses across two buckets, under-reports both, and lets real breaches
go unflagged.

`reference: risk-management/src/lib/rulepack/session.ts`

### 4.7 Evaluation

```ts
function evaluateRulePack(
  pack: RulePack,
  input: EvaluationInput,   // account, trades, snapshots?, newsEvents?, now
  packVersion: string
): EvaluationResult          // { accountId, decisions[], skipped[] }
```

Rules for the implementation:

- **Pure.** No database, no clock, no network. `now` is an input so replay is
  reproducible.
- Skip a rule that is absent, `enabled: false`, or whose `applies_to_phases` does
  not include the account's phase. These are configurations, not omissions.
- Cross-account rules go to `skipped` with the partitioning reason.
- Every decision carries `evidence`: the limit as written, what was observed,
  **the arithmetic spelled out**, the contributing trade ids, the session day,
  and a machine-readable `values` map for reconciliation. The evidence has to
  stand on its own months later without the code that produced it.
- Every decision carries an `idempotencyKey` over (pack version, account, rule,
  inputs).
- Sort decisions by finality — `terminate`, `pause_trading`, `flag_for_review`,
  `warn` — then by amount exceeded. A terminated account is not also "flagged for
  review", and a risk desk reading a queue needs the account-ending decision
  first.

### 4.8 Versioning, hashing and activation

- **Content hash** over the pack canonicalised with sorted keys, so two packs
  that mean the same thing hash the same regardless of serialisation order.
  Without canonicalisation every save looks like a change and version numbers
  climb for nothing.
- **Versions are per (tenant, name)**: editing "House Rules" produces v2 of the
  same pack, which is what makes the version pinned on a decision meaningful.
- **Lifecycle** `draft → testing → active → archived`. `testing` is real and
  evaluated, but its decisions are recorded `enforced: false`.
- **Immutability:** any status past `draft` refuses edits with an error that says
  why — past decisions were made under it — and tells the caller to fork.
- **Activation refuses** unless a completed backtest exists **and** that
  backtest's `providerOnly` list is empty. Archive the incumbent before promoting
  the new pack, so the partial unique index is never violated.

### 4.9 Presets and provenance

Ship starting points modelled on the market's best-known shapes, because firms
overwhelmingly copy one another and adjust a number — a firm that recognises its
own shape can be live in minutes instead of on an onboarding call.

The reference implementation ships seven: Apex-style, TopStep-style,
Tradeify-style, Lucid-style, FTMO-style, FundedNext-style, The5ers-style. The
names describe a **rule shape**, not an affiliation.

Every preset carries provenance:

```ts
interface PresetProvenance {
  source: string | null;      // a URL a human can open and compare
  verifiedAt: string | null;  // null means NOBODY HAS checked it
  verifiedBy?: string;
}

// unverified -> never checked; stale -> checked more than 90 days ago
type PresetConfidence = 'verified' | 'stale' | 'unverified';
```

Staleness is **data the product acts on**, not a caveat in a document nobody
reads: a preset that has never been checked says so wherever it appears, and the
notice is written for the customer, because they are the one who will be
enforcing it. A stale preset applied as-is breaches accounts against rules nobody
agreed to — strictly worse than shipping no preset, because it carries false
authority.

Every preset is created as a `draft` and must pass a backtest like anything else.

`reference: risk-management/src/lib/rulepack/presets.ts`

---

## 5. The provider adapter contract

### 5.1 The interface

```ts
interface TradingProvider {
  readonly meta: ProviderMeta;

  isConfigured(tenantId?: string): Promise<boolean>;

  listAccounts(tenantId?: string): Promise<NormalizedAccount[]>;
  getAccount?(accountId: string, tenantId?: string): Promise<NormalizedAccount | null>;
  getUser(userId: string, tenantId?: string): Promise<NormalizedUser | null>;
  getBalanceEquity(accountId: string, tenantId?: string):
    Promise<{ balance: number; equity: number } | null>;
  getOpenPositions(accountId: string, tenantId?: string): Promise<NormalizedTrade[]>;
  getClosedTradeHistory(accountId: string, tenantId?: string): Promise<NormalizedTrade[]>;
  getPayouts(tenantId?: string): Promise<NormalizedPayout[]>;
  getRiskViolations(accountId: string, tenantId?: string): Promise<NormalizedViolation[]>;

  // Present only where the platform API supports enforcement.
  enforce?(accountId: string, action: EnforcementAction, tenantId?: string):
    Promise<{ ok: boolean; message: string }>;
}
```

Every method takes a trailing optional `tenantId`. When supplied, the adapter
resolves credentials — and any cached auth token — for **that tenant only**.

`reference: risk-management/src/lib/providers/interface.ts`

### 5.2 The registry

Static metadata for every platform, so the UI and the engine can reason about a
platform without loading its adapter:

| Field | Meaning |
|---|---|
| `assetClass` | `forex` or `futures` |
| `kind` | `native-violations` — the platform computes breaches server-side; or `raw-data` — pull trades and equity and compute breaches in the engine |
| `manager` | `true` if one credential set monitors the whole firm; `false` if access is per-trader and keys must be collected from each |
| `transport` | REST, WebSocket, protobuf, gRPC — surfaced in the UI so an operator knows what they are signing up for |
| `docsUrl` | The real API documentation |

`kind` is the field that decides whether a firm's data flows into the rule engine
or is reconciled against the platform's own verdicts. `manager: false` is a
product constraint, not a detail: a platform whose API is per-trader cannot be
monitored firm-wide from one credential, and saying so on the connections page is
cheaper than discovering it during onboarding.

`reference: risk-management/src/lib/providers/registry.ts`

### 5.3 Per-tenant credentials

**Envelope encryption.** One master key lives in the environment
(`CONNECTIONS_MASTER_KEY`), never in the database, and is never used to encrypt
data directly. Each tenant gets its own AES-256-GCM data key, derived from the
master by HKDF-SHA256 with **the tenant id as salt** and the key version as info.

```
blob = "<keyVersion>.<iv>.<authTag>.<ciphertext>"   // all base64
key  = HKDF-SHA256(master, salt = tenantId, info = "connections-secrets-v<version>", 32)
```

Consequences, and they are the point:

- A leaked database row is useless without the master key.
- Tenant A's derived key cannot decrypt tenant B's blob, even for someone holding
  the master key, unless they also know tenant B's id **and** the blob was
  actually encrypted under it — GCM's auth tag makes a wrong-key attempt fail
  closed rather than return plausible garbage.
- Rotation is a version bump, not a rewrite: old blobs stay decryptable during
  the rotation window because the version travels with the ciphertext.
- Decryption failure and JSON-parse failure raise the **same** error, so a caller
  cannot use the error shape to probe whether a tenant id is "close".

The module refuses to load in a browser bundle. A transitive import once dragged
it clientward through the provider facade; an explicit `typeof window` assertion
turns that into a readable failure at the point of the mistake.

**Resolution order.** `getProviderConfig(id, tenantId)` reads the tenant's
`connections` row; when the tenant has not connected that provider yet it falls
back to environment variables, so a freshly onboarded tenant is not hard-broken
before they have filled in the page. `getProviderConfig(id)` with no tenant is
the env-only path.

**Token caches must be per tenant.** Two adapters originally held session tokens
in module-scoped variables. Shared, the first firm to authenticate populates the
module and every later firm's requests go out under that firm's token. Cache in a
`Map` keyed by tenant id.

### 5.4 Validation

Connecting credentials and *proving* they work are separate steps.
`POST /api/connections/[provider]/validate` performs a real read against the
platform and writes `status` (`valid` | `invalid`), `last_validated_at` and
`last_error`. Discovering that a key is read-only, or scoped to the wrong
account group, belongs in onboarding rather than in the first cron run at 3am.

### 5.5 Stub policy

An adapter that is not implemented must:

- appear in the registry with its **real** transport, `kind`, `manager` flag and
  documentation URL, since that information is what a firm needs to plan;
- return mock data in demo mode;
- throw a `NotConfiguredError` naming the variable to set and the block to
  implement when called for real;
- never return an empty list where a live call would have returned data. An empty
  list reads as "no breaches" and is the exact silent-success failure this whole
  system is built to avoid.

---

## 6. The four flows

Each step names the data written, because "the flow works" is not checkable and
"the row exists with these columns set" is.

### 6.1 Flow 1 — Onboarding: signup to enforcing

The whole point of the architecture is that this needs no call from the vendor.

| # | Step | Written |
|---|---|---|
| 1 | Signup, or purchase first if `BILLING_ENABLED=true` and you are running this as a hosted service | `subscriptions` row (only if billing is on) |
| 2 | `POST /api/tenancy/signup` creates the firm and its owner | `tenants` (with `enforcement_approval_required = true`), `tenant_members` with role `owner`; the tenant claim is minted into the user's `app_metadata` |
| 3 | Invite the team | `tenant_invites` (hash only, with an expiry); on acceptance a `tenant_members` row and a claim |
| 4 | Connect the trading platform at `/connections` | `connections` row, secrets envelope-encrypted, `status = 'unvalidated'` |
| 5 | **Validate** — a real read against the platform | `connections.status`, `last_validated_at`, `last_error` |
| 6 | Pick a preset and tune it | `rule_packs` row, `status = 'draft'`, `version` = next for (tenant, name), `content_hash` |
| 7 | **Backtest in shadow mode** — replay the firm's own last 90 days | `backtest_runs` with `reconciliation_json`; `breach_decisions` with `enforced = false` |
| 8 | Read the reconciliation | — |
| 9 | Platform sign-off, while the tenant is gated | `rule_packs.platform_approved_by`, `_at`, `_note`, `_backtest_id` |
| 10 | Activate | incumbent pack archived, then `status = 'active'`, `approved_by`, `effective_from` |

**The backtest is the onboarding.** It is not a feature that happens to exist; it
is the mechanism that makes self-serve safe. A firm does not have to trust a
vendor's claim that its engine understands trailing drawdown — it watches the
engine reproduce the firm's own history.

The reconciliation is deliberately **asymmetric**:

- Breaches the engine found that the platform did not → `engineOnly` →
  **surfaced, not blocking.** Often this is why a firm is switching. Some are
  genuine catches, some are a mis-set parameter, and a human should look at both.
- Breaches the platform enforced that the engine missed → `providerOnly` →
  **blocking.** Activating past this silently relaxes the firm's own rules. That
  is the single failure mode a risk platform must never have.
- **Any rule that could not be evaluated is also blocking**, because the run did
  not prove coverage. "No breach" and "not checked" must never read the same.

Match a reconciliation on (account, rule), not on timestamp: platforms stamp a
breach when their job noticed it and the engine stamps it when it occurred, and
those legitimately differ by minutes. Requiring an exact time match reports every
agreement as a disagreement.

### 6.2 Flow 2 — The monitoring loop

This should be the most boring part of the system.

```
per tenant, on a schedule:
    ingest accounts + trades + equity snapshots from THAT tenant's platform
        │
        ▼
    load that tenant's ACTIVE rule pack (exactly one per asset class)
        │
        ▼
    for each account:
        bucket activity into SESSION days (firm's timezone + day_start)
        run each enabled primitive whose phase scope matches the account
        │
        ▼
    emit breach decisions, each carrying:
        the rule, the limit, what happened, the arithmetic, the trades,
        and an idempotency key over (pack version + account + rule + inputs)
```

| Step | Written |
|---|---|
| Ingest | `accounts`, `trades`, `equity_snapshots` (with `sample_interval_seconds`) |
| Evaluate | nothing — the engine is pure |
| Persist decisions | `breach_decisions`, upserted on `idempotency_key` so a re-run is a no-op |
| Raise for humans | `violations` linked to an `enforcement_queue` row with `status = 'pending'` |
| Assemble evidence | `evidence_packs`, and the drafted notice stored on the queue row — **drafted, never sent** |
| Report | the job's response body carries counts per tenant **and** the `skipped` rules with their reasons |

### 6.3 Flow 3 — The breach flow

```
breach decision recorded
        │
        ▼
evidence pack assembled AUTOMATICALLY
    trade tape · the rule as written · the arithmetic ·
    related accounts · prior decisions · hash-chained audit entries
        │
        ▼
trader notice DRAFTED (not sent)
        │
        ▼
╔════════════════════════════════════════════════╗
║  HUMAN RISK MANAGER — the enforcement queue    ║
║  approve · modify · reject · escalate          ║
╚════════════════════════════════════════════════╝
        │
        ▼
action on the platform (restrict / suspend / flatten)
notice sent to the trader
decision + approver identity written to the audit chain
```

The human step is the product, not a limitation. What the system removes is the
twenty minutes of assembling evidence, not the judgment — and it means every
enforcement action has a named human behind it, which is precisely what an audit
trail must be able to say.

**What the trader receives decides whether this becomes a dispute.** The notice
must contain, in this order: the rule as written, what happened, the arithmetic,
the trades, and a link to the full decision record. For example:

> Your account 1001 breached the daily loss limit on the 2 March session.
>
> **The rule:** maximum daily loss of $5,000 (5% of your $100,000 starting
> balance), measured on equity including open positions, reset at 17:00 ET.
>
> **What happened:** you lost $6,000 across 4 trades.
>
> **The arithmetic:** peak equity $102,500 − closing equity $96,500 = $6,000
> against a $5,000 limit, exceeding it by $1,000.
>
> **The trades:** [full tape]
>
> Full decision record: [link]

A trader who reads that argues with the market. A trader who receives "your
account has been terminated for a rule violation" opens a chargeback.

### 6.4 Flow 4 — The payout flow

Payouts are where firms actually lose money, and where evidence matters most
because real cash moves.

| # | Step | Written |
|---|---|---|
| 1 | Trader requests a payout | `payout_history` snapshot |
| 2 | Automatic risk check against the active pack, undeducted violations, fraud signals (rings, shared identity, coordinated timing), consistency, IP and device overlap | risk snapshot on the payout row |
| 3 | Recommendation with a **deterministic** rationale: cited rules, the maths, risk factors, adjusted amount | `payout_decisions` draft |
| 4 | **Human** approves, rejects or adjusts | — |
| 5 | **Provider call FIRST** | — |
| 6 | Then persist | `payout_decisions` final, `audit_log` entry naming the approver, `payout_history` updated |

Ordering in steps 5 and 6 is the invariant (I8): the platform call happens before
persistence, so a provider failure never leaves a decision row claiming a payout
that did not happen.

### 6.5 Flow 5 — Disputes (the closing loop)

A dispute opens against the evidence pack **as it existed at decision time** —
looked up, never rebuilt. Re-scoring a two-year-old decision under today's rules
answers a question nobody asked. Every state change joins the hash chain naming
the human, and overturn rate is tracked per rule, because a rule that is
overturned often is a rule that is written wrong.

---

## 7. Tenancy and authentication

### 7.1 Layer 1 — the tenant claim

Every session carries `tenant_id` and `role` in **`app_metadata`**, minted
server-side from `tenant_members` at sign-in and at invite acceptance.

Never `user_metadata`: it is writable by the user through the auth client, so
authorization read from it lets any signed-in user promote themselves to admin.
This was a real defect in the reference codebase, which is why the CI guard
checks for it permanently.

A guard refuses a session that has a valid role but no tenant. **A tenantless
session is unusable, not global.**

Roles: `owner`, `admin`, `risk_manager`, `risk_analyst`, `viewer`. Enforcement
-grade actions — restricting, suspending or flattening an account, batch
enforcement — require `risk_manager` or `admin`.

### 7.2 Layer 2 — row-level security

§3.1 and §3.2. `WITH CHECK` on writes; `FORCE ROW LEVEL SECURITY`; a NULL claim
fails every policy closed.

### 7.3 Layer 3 — request-scoped database access

Route handlers reach the database as the signed-in user (anon key plus their
cookies), so RLS constrains them. The service-role client holds `BYPASSRLS`; a
route handler calling it directly is a route where every policy above is switched
off. Allowed exceptions, each with a reason, are exactly:

- cron routes — no session by definition, already gated on `CRON_SECRET`, and
  they fan out per tenant internally;
- the health check — reads no tenant data;
- signup and invite acceptance — run *before* the caller has a tenant claim, and
  are constrained to the tenant named by the row they were handed.

### 7.4 Layer 4 — the scoped data-access layer

Background work has no session, so it must use the service role. For that code
path RLS is **not** a safety net, and the failure mode is not malice: it is a
future `.from('accounts').select('*')` written by someone who forgot, which under
the service role silently returns every firm's data and looks like it works.

```ts
const db = tenantDb(tenantId, 'detect-violations cron');
await db.from('accounts');            // pre-filtered by tenant_id
await db.insert('violations', row);   // stamped, overriding any tenant_id in the payload
await db.update('violations', patch); // tenant_id DISCARDED from the patch
await db.delete('violations');        // constrained
globalTable('news_events');           // the only way across the boundary
listActiveTenantIds();                // the only sanctioned way to iterate tenants
```

Three details are load-bearing:

- **Inserts and upserts are stamped, not merged.** A mistaken or reflected
  `tenant_id` in a payload cannot redirect a write.
- **Updates discard `tenant_id` rather than re-stamping it**, because permitting
  `SET tenant_id = ...` would move a row across the boundary.
- **You cannot obtain a query builder without a tenant id.** A missing or
  malformed id throws, naming the call site.

### 7.5 Layer 5 — runtime partitioning

Isolation is not only a database concern:

- **Provider token caches** keyed by tenant, never module-scoped. Shared, the
  first firm to authenticate populates the module and every later firm's requests
  use that firm's token.
- **Redis keyspace** namespaced per tenant; one global queue key means one firm's
  jobs can be drained by another's worker.
- **Cross-account scans** partitioned. Ring detection compares every account
  against every other; unpartitioned, that surfaces one firm's trading patterns
  inside another firm's alerts — a leak that never touches a row the reader was
  forbidden to read.
- **Unique constraints** scoped by tenant wherever they are keyed on a
  provider-issued value. Two firms routinely both have an account numbered 1001.

### 7.6 The middleware

Deny by default, so a new route is protected automatically:

```
/api/cron/*            → require Bearer CRON_SECRET. Enforced EVEN IN DEMO MODE.
/api/platform-admin/*  → require Bearer PLATFORM_ADMIN_SECRET, checked BEFORE the
                         demo bypass, so a demo deployment can never expose it.
demo mode              → everything public, mock data
public allowlist       → marketing, login, signup, accept-invite, health,
                         signup + invite-accept APIs, the Stripe webhook,
                         and the trader surface
everything else        → a Supabase session, or 401 for APIs / redirect for pages
```

The allowlist lives in its own module so its prefix-matching rule can be tested
directly. `'/'` in a prefix list looks like it makes the whole application
public; it does not, because the match is `pathname === page ||
pathname.startsWith(page + '/')` and for `'/'` the second arm becomes
`startsWith('//')`. That claim belongs in a test rather than in a reviewer's
head.

`PLATFORM_ADMIN_SECRET` must be distinct from `CRON_SECRET`: leaking one must not
grant the other, and the platform-admin routes act *across* tenants.

### 7.7 Trader tokens

Traders are not tenant members and have no session. The token in their URL is the
entire authentication boundary, so:

- generate 32 random bytes; **store only the sha256 hash**; the raw token exists
  only in the link handed to the firm once;
- compare digests in constant time, never the raw token, never with `===`;
- carry an expiry (30 days is a sensible default — long enough to cover a
  challenge, short enough to force rotation) and support revocation;
- resolve to exactly one (tenant, account) pair and nothing wider.

---

## 8. Background jobs

Nine scheduled jobs. Every one of them fans out per tenant.

| Job | Schedule | What it does |
|---|---|---|
| `ingest-trades` | every minute | Pull accounts and trades per tenant |
| `detect-violations` | every 5 minutes | Evaluate the active pack; persist decisions; queue for humans |
| `process-violations` | every minute | Drain the violation queue |
| `sample-equity` | every 5 minutes | Poll equity snapshots so intraday rules become evaluable |
| `fraud-hunter` | every 15 minutes | Cross-account detectors, tenant-partitioned |
| `enforce` | every 15 minutes | Expire stale queue items, escalate ageing ones |
| `reviewer` | nightly, Mon–Sat | Verify executed deductions against the platform |
| `morning-report` | daily | Per-tenant summary |
| `sync-news` | weekly | Economic calendar |

### 8.1 The fan-out helper

Every job goes through one helper rather than reimplementing the loop, because
the two properties below get reimplemented wrong:

1. **Bounded concurrency.** A firm with ten times everyone else's accounts must
   not be able to starve the others by holding every worker slot for the whole
   execution window. Default 3.
2. **Failure isolation.** One tenant's job throwing — bad provider credentials, a
   transient database error — must not abort the batch. It is logged, the loop
   continues, and the response reports that tenant as failed alongside every
   tenant that succeeded.

```ts
const outcomes = await fanOutToTenants(runForOneTenant, {
  jobName: 'detect-violations',
  concurrency: 3,
});
// outcomes: Array<{ tenant_id, ok, result?, error? }>
```

### 8.2 Honest results

This is invariant I9, and it is the one most often violated by accident.

- A job returns **what it persisted**, not what it attempted.
- Rules that could not be evaluated appear in the response with their reasons,
  deduplicated by (rule, reason) — a firm with 500 accounts missing snapshots
  needs one finding, not five hundred.
- A job that found nothing to scan says so explicitly, rather than returning a
  success shape full of zeros that is indistinguishable from a healthy quiet day.

The failure this prevents is real: a fraud scan in the reference codebase ran
successfully for months while silently discarding every finding, because a unique
index had moved beneath it. Nothing in the response distinguished that from
"there was no fraud".

---

## 9. Violation reports

A firm needs to hand a trader a document, and a trader needs to be able to check
it. That makes the report a legal artifact rather than an export feature.

### 9.1 The payload is persisted, not recomputed

Rendering reads a stored payload from `violation_reports`; it does not re-derive
the numbers from live data. A report rebuilt at download time is not evidence, it
is a query result — and its inputs do not survive:

1. **Equity snapshots are pruned.** The intraday peak that justified a
   trailing-drawdown breach is gone within days, well before a dispute reaches
   week two.
2. **Thresholds move.** Rebuilding tomorrow restates the breach against
   *today's* rule, which is the single worst thing a decision record can do.
3. **Live columns are overwritten.** `accounts.balance` and `.equity` are
   replaced on every poll, so the balance at detection time is not recoverable
   from them.

So the payload is assembled once, hashed, and read back verbatim. A
`content_hash` over the canonical payload (excluding its own id, timestamp and
actor) makes regeneration **idempotent by input**: regenerating a report whose
underlying facts have not changed returns the existing row rather than
accumulating near-identical copies, and a genuine change in the facts produces a
second row rather than silently overwriting the first. That is invariant I2
applied to documents.

The payload holds: the violation and its rule, the rule **as written at decision
time** with the pack version, the resolved limit, the observation, the arithmetic
as prose, the contributing trades, the account context (starting balance, phase,
session configuration), the deduction if any, and the audit hash.

### 9.2 Determinism

Same payload in, byte-identical document out. No `Date.now()` in the renderer, no
locale-dependent formatting, no map iteration order that depends on insertion, no
random ids. Generation time is a field of the payload, not a call in the
renderer. Test it by rendering twice and comparing bytes.

### 9.3 Endpoints

| Route | Purpose |
|---|---|
| `GET /api/violations/[id]/report?format=pdf\|csv\|json` | Render the stored payload. `json` returns the payload itself, which is what makes the other two auditable |
| `POST /api/violations/[id]/report` | Regenerate the payload — an explicit act, never a side effect of a GET |
| `GET /api/violations/account/[accountId]/report` | Account-wide CSV across every violation on the account |
| `GET /api/trader/[token]/violations/[id]/report` | The trader's own copy, authenticated by their token and scoped to their account |

Download buttons live on `/violations`, `/violations/[id]`,
`/violations/account/[accountId]`, `/disputes`, and the trader page.

### 9.4 CSV

One shared RFC 4180 writer, used by every export. Fields containing a comma,
quote or line break are quoted and embedded quotes are doubled; records end with
`\n`; the file starts with a UTF-8 byte-order mark so spreadsheet software opens
accented characters correctly. One implementation, because a second CSV writer
is a second set of quoting bugs.

---

## 10. UI contract

**The visual system is a separate document.** Read
[`../DESIGN.md`](../DESIGN.md) before writing or restyling anything. It is the
authority on tokens, the white-label themeable/structural split, severity
encoding, and a compliance gate with baselines that ratchet. This spec does not
restate it and must not contradict it.

What the UI must do, as distinct from how it must look:

- **Server components by default.** Reach for a client component when there is
  interaction or client state, not by habit.
- **Colour is never alone.** Every severity indicator carries its label or its
  score. A coloured dot is not a signal.
- **Every number is traceable to a decision that names its inputs.** A dashboard
  figure a user cannot click through to its evidence is a figure they will not
  trust when it matters.
- **`skipped` renders as `skipped`.** Never as a pass, never as a zero, never as
  an empty state that reads like "nothing wrong".

Pages, and what each must show:

| Page | Must show |
|---|---|
| `/login` | Sign in. What a signed-out visitor sees — there is no public marketing surface |
| `/signup`, `/accept-invite` | Self-serve firm creation; invite redemption |
| `/risk` | Severity distribution, violation breakdown, flagged accounts |
| `/violations` | Violations grouped by rule, each row with PDF and CSV |
| `/violations/[id]` | The rule as written, the arithmetic, the trades, the downloads |
| `/violations/account/[accountId]` | Every violation on one account plus an account-wide CSV |
| `/rules`, `/rules/new`, `/rules/[id]` | Pack list with status and version; preset picker carrying provenance and staleness; tuning, backtest, activation — with the reason activation is blocked stated in words |
| `/enforcement` | The queue: recommendation, evidence, drafted notice, approve / modify / reject / escalate |
| `/evidence/[id]` | Trade tape, rule-by-rule scoring, the hash-chained audit trail |
| `/disputes` | Cases with the pinned evidence pack, and overturn rate per rule |
| `/alerts` | The live breach feed for the selected asset class |
| `/connections` | Every adapter with its status, transport, access model, and a Validate action |
| `/network` | The cross-account graph, tenant-scoped |
| `/payouts`, `/history`, `/deductions` | Pending decisions with their risk snapshot; decided history; executed adjustments |
| `/a/[token]` | A trader's own headroom: distance to the daily loss limit, where the drawdown floor sits and whether it has locked, days traded, consistency position |
| `/settings` | Firm details, branding, per-asset rules |

---

## 11. Milestones

Thirteen milestones, in order. Each states a goal, its deliverables, and a
**verification command whose expected output is given**. A milestone is done when
its command prints what is written here. Not before.

Commands assume you are at the repository root and that the application lives in
`risk-management/`. Paste real output into your report; never paraphrase it.

### M0 — Scaffold and CI

**Goal.** An application that builds, lints, typechecks and runs its (empty) test
suite in CI, with the secret-hygiene gates already in place — so no later
milestone can be the one that "adds security".

**Deliverables.** Next.js 14 App Router project, TypeScript `strict`, Tailwind,
vitest, `.env.local.example` with every variable annotated, a health route, a CI
workflow (lint, typecheck, test, build) and a security workflow (secret scan,
banned-terms scan, dependency audit).

```bash
cd risk-management && npm ci && npm run lint && npm run typecheck && npm test && npm run build
```

Expected: all five succeed; the build emits a route list; the test run reports
zero failures.

### M1 — Tenancy, RLS, guards, isolation checks

**Goal.** The five isolation layers, before any feature exists to leak.

**Deliverables.** `tenants` / `tenant_members` / `tenant_invites`;
`auth_tenant_id()` and `auth_tenant_role()`; the RLS block on every table; column
privileges on `tenants`; the `app_metadata` guards; the deny-by-default
middleware with its tested public allowlist; `tenantDb()` / `globalTable()` /
`listActiveTenantIds()`; the CI isolation guard and the SQL isolation suite.

```bash
cd risk-management && node scripts/check-isolation.mjs \
  && npx vitest run src/lib/db src/lib/auth src/lib/tenancy
bash risk-management/supabase/tests/verify-isolation.sh   # needs Postgres 17 on :55432
```

Expected: `Isolation guard: clean`, then the migration count and the two "no
route bypasses RLS / no guard reads user_metadata" lines; the vitest run passes;
the SQL suite asserts that firm A cannot read, insert into, update into or delete
from firm B, and that a claimless token sees nothing.

### M2 — The rule engine and its golden vectors

**Goal.** A pure, deterministic evaluator over the 13 primitives, pinned by
hand-computed vectors.

**Deliverables.** The schema and semantic validation (§4.3, §4.5); session-day
bucketing (§4.6); all 13 primitives; `evaluateRulePack`; the seven presets with
provenance; a golden-vector suite whose expected values were computed by hand,
not captured from the implementation.

```bash
cd risk-management && npx vitest run src/lib/rulepack
```

Expected: every file passes, including `golden-vectors.test.ts`. Those vectors
are the contract — if a change makes one fail, the change is wrong until proven
otherwise.

### M3 — The provider layer, two live adapters, the credential vault

**Goal.** Real data from at least two platforms, with credentials that are safe
at rest and partitioned at runtime.

**Deliverables.** The `TradingProvider` interface, the registry with accurate
`kind` / `manager` / `transport` metadata for all ten, two live adapters
(MatchTrader and Tradovate in the reference), eight documented stubs that throw
rather than return empty, envelope encryption, the `connections` table, and the
validate endpoint.

```bash
cd risk-management && npx vitest run src/lib/crypto src/lib/connections src/lib/providers src/lib/cache
```

Expected: passes, including a test proving that tenant A's derived key cannot
decrypt tenant B's blob, and that adapter token caches are keyed by tenant rather
than module-scoped.

### M4 — The monitoring loop and snapshot ingestion

**Goal.** Data arriving per tenant on a schedule, with the intraday gap closed or
honestly reported.

**Deliverables.** `ingest-trades`, `sample-equity`, the push endpoint and
per-tenant ingest keys, the fan-out helper with bounded concurrency and failure
isolation, and `sample_interval_seconds` stored alongside every snapshot.

```bash
cd risk-management && npx vitest run src/lib/ingest src/app/api/cron
```

Expected: passes, including a test that one tenant's failure does not abort the
batch and that the response reports that tenant as failed alongside the
successes.

### M5 — The breach flow, evidence packs, the audit chain

**Goal.** A breach that produces an artifact a firm could hand to a trader.

**Deliverables.** Persisting `breach_decisions` keyed on the idempotency key;
creating `violations` linked to their enforcement item; the evidence pack builder;
the drafted trader notice; the SHA-256 hash-chained `audit_log` with canonicalised
details.

```bash
cd risk-management && npx vitest run src/lib/evidence src/lib/audit
```

Expected: passes, including a test that tampering with one entry breaks the chain
from that point on, and that re-running detection over identical inputs creates
no second decision row.

### M6 — The enforcement queue

**Goal.** The human step, with escalation that cannot silently expire something
important.

**Deliverables.** The queue with severity scoring, repeat-offender multipliers,
escalation levels with deadlines, expiry of stale items, batch approve and
reject, and provider-wired restrict / suspend / flatten behind
`risk_manager`-or-above.

```bash
cd risk-management && npx vitest run src/lib/enforcement src/lib/deductions
```

Expected: passes, including that no code path executes an action without an
approver identity attached.

### M7 — Payouts

**Goal.** Money moves only after a human decision, and only in the safe order.

**Deliverables.** Pending payouts with risk checks and IP checks, the explainable
decision with cited rules and the arithmetic, the pre-approval workflow, history
and sync, and the liability forecast.

```bash
cd risk-management && npx vitest run src/lib/payouts src/lib/forecast src/app/api/payouts
```

Expected: passes, including a test that a failing provider call leaves **no**
persisted decision — invariant I8.

### M8 — The trader view

**Goal.** A trader can see their own position against their own firm's rules,
without an account.

**Deliverables.** `trader_access_tokens` storing only the hash; mint, list and
revoke; the headroom projection computed from the same primitives the breach
engine uses; the public page and its API route.

```bash
cd risk-management && npx vitest run src/lib/trader
```

Expected: passes, including `isolation.test.ts` — a token resolves to exactly one
(tenant, account) pair, an expired or revoked token resolves to nothing, and no
token reaches another firm's data.

### M9 — Disputes

**Goal.** The loop closes: a disputed decision is answered from the record that
existed when it was made.

**Deliverables.** The `disputes` table with the RLS block copied verbatim; open,
transition and resolve; the evidence pack **looked up, not rebuilt**; every
transition joining the audit chain; overturn rate per rule.

```bash
cd risk-management && ls src/lib/disputes/lifecycle.ts supabase/migrations/00023_disputes.sql \
  && grep -c "auth_tenant_id()" supabase/migrations/00023_disputes.sql \
  && npx vitest run src/lib/disputes src/lib/evidence
```

Expected: both files list; the grep prints at least `4` (one per authenticated
policy); the tests pass.

### M10 — Optional billing

**Goal.** Billing is optional and off by default, because this is a self-hosted
admin console, not a hosted product with a marketing surface. Set
`BILLING_ENABLED=true` if you want to run it as a hosted service for other
firms.

**Deliverables.** Stripe checkout, portal and a signature-verified webhook,
gated behind `BILLING_ENABLED` — the three `/api/billing/*` routes return 404
and no Stripe env var is read while it is off; metering by funded accounts
monitored; entitlements enforced against `tenants.max_accounts` when billing is
on. No landing or pricing page — signed-out visitors see `/login`.

```bash
cd risk-management && npx vitest run src/lib/billing src/app/api/billing
```

Expected: passes, including that a webhook with a bad signature is rejected —
that signature is the route's only authentication.

### M11 — Violation reports

**Goal.** A document a trader can check, that does not change between downloads.

**Deliverables.** The `violation_reports` payload table; deterministic PDF and
CSV renderers over the stored payload; the four endpoints in §9.3; download
buttons on the five surfaces; the shared RFC 4180 CSV writer.

```bash
cd risk-management \
  && grep -rl 'violation_reports' supabase/migrations/ \
  && ls 'src/app/api/violations/[id]/report/route.ts' \
        'src/app/api/violations/account/[accountId]/report/route.ts' \
        'src/app/api/trader/[token]/violations/[id]/report/route.ts' \
  && npx vitest run 2>&1 | tail -3
```

Expected: the migration file is named; all three route files list; the suite
reports zero failures — including a test that renders the same payload twice and
compares bytes.

### M12 — Hardening

**Goal.** Nothing ships that should not, and nothing breaks quietly.

**Deliverables.** Rate limits on the sensitive endpoints (Redis with an in-memory
fallback, keys namespaced per tenant); security headers; a secret scan and a
banned-terms scan in CI; documentation that resolves; `LICENSE`, `SECURITY.md`,
`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`.

```bash
bash scripts/release/check-banned-terms.sh \
  && node scripts/release/check-doc-links.mjs \
  && cd risk-management && npm run lint && npm run typecheck && npm test && npm run check:isolation && npm run build
```

Expected: `banned-terms: clean`, `Doc links: clean`, `Isolation guard: clean`,
zero test failures, and a successful production build.

---

## 12. Test and CI contract

**What must be tested, and why that thing rather than coverage:**

| Area | The test that matters |
|---|---|
| Rule engine | **Golden vectors** with hand-computed expected values. Capturing the implementation's own output pins a bug in place. |
| Session days | A trade at 18:00 Sunday lands in Monday's bucket under a 17:00 ET session, and a `00:00` session does not shift anything. |
| Schema validation | Each semantic rule in §4.5 rejects its case, with the message a human needs. |
| Isolation | Tenant A cannot read, insert into, update into or delete from tenant B; a claimless token sees nothing; `tenantDb` refuses a missing id, stamps inserts and discards `tenant_id` from updates. |
| Crypto | Tenant A's key cannot decrypt tenant B's blob; a tampered auth tag fails closed; decryption failure and parse failure are indistinguishable to the caller. |
| Public allowlist | `'/'` makes only the root public. |
| Fan-out | One tenant's failure does not abort the batch and is reported. |
| Determinism | Rendering the same report payload twice produces identical bytes. |
| Provider ordering | A failing provider call leaves no persisted payout decision. |
| Idempotency | Re-running detection over identical inputs creates no second decision. |

**CI pipeline** (`.github/workflows/ci.yml`): install, lint, typecheck, test,
isolation guard, build — with placeholder Supabase values and demo mode on so the
build needs no secrets.

**Security pipeline** (`.github/workflows/security.yml`): gitleaks over the full
history, the banned-terms scan, and `npm audit --audit-level=high`, plus a weekly
schedule so a dependency advisory published after merge is still caught.

**The SQL isolation suite is not in CI** because it needs a real Postgres 17.
Run it locally after touching anything tenant-scoped, and before any release.

---

## 13. Definition of done

The system is complete when every line below is true and demonstrable. This is
the list to walk before saying the build is finished.

**Correctness**

- [ ] The evaluator is pure: no database, no network, no clock inside it.
- [ ] Golden vectors pass and their expected values were computed by hand.
- [ ] Re-running any job over identical inputs writes nothing new.
- [ ] A rule that could not be evaluated appears as `skipped` with a reason, in
      the API response and in the UI, and never as a pass.
- [ ] Session-day bucketing is correct across a DST transition and for a
      `00:00` day start.

**Isolation**

- [ ] `node risk-management/scripts/check-isolation.mjs` prints
      `Isolation guard: clean`.
- [ ] `bash risk-management/supabase/tests/verify-isolation.sh` passes against a
      real Postgres.
- [ ] Every tenant table has `tenant_id`, forced RLS, four authenticated policies
      and one service-role policy.
- [ ] No route handler calls the admin client outside the four justified
      exceptions.
- [ ] No code reads a role or tenant from `user_metadata`.
- [ ] Provider token caches, Redis keys and cross-account scans are partitioned
      by tenant.

**Governance**

- [ ] A pack past `draft` cannot be edited; editing forks a version.
- [ ] Activation is refused without a completed backtest, and refused while the
      reconciliation shows a breach the platform caught and the pack missed.
- [ ] At most one active pack per (tenant, asset class), enforced by a database
      constraint.
- [ ] Every breach decision pins the pack version that produced it.
- [ ] No enforcement action reaches a trading platform without a named approver
      in the audit chain.
- [ ] The provider call precedes persistence on every path that moves money.

**Artifacts**

- [ ] Every breach produces an evidence pack containing the rule as written, the
      arithmetic, and the contributing trades.
- [ ] A violation report renders identically twice.
- [ ] A dispute pins the evidence pack that existed at decision time.
- [ ] The audit chain detects tampering.

**Operability**

- [ ] `NEXT_PUBLIC_DEMO_MODE=true` runs the whole product with no backend.
- [ ] With only Supabase configured, the app runs: no Redis, no Stripe, no email,
      no provider.
- [ ] `GET /api/health` reports environment, database and Redis with latencies.
- [ ] Every job's response says what it persisted, per tenant, including
      failures.

**Honesty**

- [ ] The documentation names every adapter that is a stub.
- [ ] Every preset carries its source and its verification date, and the product
      says so where the preset is chosen.
- [ ] `banned-terms: clean` and `Doc links: clean`.
- [ ] Nothing claims to have run against a real funded account unless it has.
