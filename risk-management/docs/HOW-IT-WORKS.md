# How this platform works

A design document, not a feature list. It describes what the product actually
is, the four flows that matter, and the decisions that shape it — including the
ones that are deliberately unglamorous.

---

## 1. What the product actually is

It is tempting to describe this as risk-management software. That framing is
wrong and it leads to building the wrong things.

Every prop firm already has risk management. MatchTrader computes drawdown.
Tradovate auto-liquidates. Rithmic has an RMS. A firm does not need a second
system to tell it that an account went below a number — its platform already
did that, in real time, better.

What no firm has is a **system of record for risk decisions**: a place where the
rules are written down once, applied identically to every account, and where
every breach and every payout decision leaves behind an artifact that can be
handed to a disputing trader, a payment processor, or a regulator.

That is the product. The detector is table stakes. The **decision, its evidence,
and the audit trail** are the thing being sold.

This reframing has consequences that run through everything below:

- The engine must be deterministic and replayable. Not because determinism is
  elegant, but because "we cannot reproduce why we terminated your account" is
  the end of a dispute you lose.
- A human approves enforcement. Not because the automation is untrustworthy, but
  because a firm's risk team must remain the author of its own decisions.
- The evidence pack is not a reporting feature bolted on at the end. It is the
  deliverable.

### Where the money leaks today

Firms lose money in three places, and each maps to something here:

| Leak | What it costs | What answers it |
|---|---|---|
| Disputed breaches | refunds, chargebacks, reputation | evidence packs |
| Inconsistent enforcement | one analyst is lenient, another strict | one rule pack, applied identically |
| Payouts approved on gut feel | paying out on manipulated accounts | risk check + recorded rationale |

Notice none of those is "we failed to detect a drawdown."

---

## 2. The four flows

### Flow 1 — Onboarding: purchase to enforcing

The whole point of the architecture is that this needs no call from us.

```
purchase ──▶ tenant + owner account ──▶ invite team
                                          │
                                          ▼
                              connect trading platform
                              (credentials, encrypted per tenant)
                                          │
                                          ▼
                              validate: can we actually read
                              your accounts and trades?
                                          │
                                          ▼
                              pick a preset ──▶ tune parameters
                              (Apex / TopStep / Tradeify / Lucid /
                               FTMO / FundedNext / The5ers-style)
                                          │
                                          ▼
                        ┌─────  SHADOW MODE (backtest)  ─────┐
                        │  replay YOUR last 90 days through   │
                        │  YOUR pack, with nothing enforcing  │
                        └─────────────────┬───────────────────┘
                                          ▼
                              reconciliation vs what your
                              platform actually reported
                                          │
                              ┌───────────┴───────────┐
                              ▼                       ▼
                    misses a breach your        matches, or finds
                    platform caught             more than yours did
                              │                       │
                              ▼                       ▼
                    BLOCKED — fix the pack     platform review
                                               (first cohort only)
                                                      │
                                                      ▼
                                                 ACTIVATE
```

**The backtest is the onboarding.** It is not a feature that happens to exist;
it is the mechanism that makes self-serve safe. A firm does not have to trust a
vendor's claim that its engine understands trailing drawdown — it watches the
engine reproduce its own history.

The reconciliation is deliberately asymmetric:

- Breaches the engine found that the platform did not → **surfaced, not
  blocking.** Often this is why a firm is switching. Some will be genuine
  catches, some a mis-set parameter. Either way a human should look.
- Breaches the platform enforced that the engine missed → **blocking.**
  Activating past this silently relaxes the firm's own rules. That is the single
  failure mode a risk platform must never have.

A run in which any rule could not be evaluated is also blocking, because it did
not prove coverage. "No breach" and "not checked" must never read the same.

### Flow 2 — The monitoring loop

This should be the most boring part of the system.

```
per tenant, on a schedule:
    ingest accounts + trades + equity snapshots from that tenant's platform
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

Three properties are non-negotiable:

1. **Deterministic.** The same inputs against the same pack version always
   produce the same decisions. No model output, no wall-clock dependency, no
   randomness. A breach decision is money and legal exposure.
2. **Idempotent by input, not by clock.** Re-running a job is a no-op. A
   corrected trade tape or a new pack version is genuinely a new decision. The
   old engines deduped on a one-hour (and elsewhere six-hour) window, which
   returns different answers depending on when the cron happened to fire and
   makes replay impossible.
3. **Honest about what it could not do.** A rule that needs intraday equity
   snapshots and did not get them reports `indeterminate`, never "no breach."

**Where an LLM belongs, and where it must never go:**

| Good | Forbidden |
|---|---|
| drafting a rule pack from an uploaded rulebook (human approves) | deciding whether a breach occurred |
| writing the prose of a trader notice from deterministic evidence | recomputing a deduction |
| summarising a dispute for support | choosing an enforcement action |
| explaining what changed between pack v1 and v2 | interpreting an ambiguous rule live |

The line is simple: a model may **describe** a decision, never **make** one.

### Flow 3 — The breach flow (the differentiator)

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
║  approve · reject  (escalation is automatic)   ║
╚════════════════════════════════════════════════╝
        │
        ▼
action on the platform (restrict / suspend / flatten)
notice sent to the trader
decision + approver identity written to the audit chain
```

The human step is the product, not a limitation. Firms keep their risk teams;
what the system removes is the twenty minutes of assembling evidence, not the
judgment. It also means every enforcement action has a named human behind it —
which is precisely what an audit trail must be able to say.

**What the trader receives** decides whether this becomes a dispute:

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

A trader who reads that argues with the market, not with the firm. A trader who
receives "your account has been terminated for a rule violation" opens a
chargeback and posts on Discord.

### Flow 4 — The payout flow

Payouts are where firms actually lose money, and where the evidence matters most
because real cash moves.

```
trader requests payout
        │
        ▼
automatic risk check against:
    the active rule pack · undeducted violations ·
    fraud signals (rings, shared identity, coordinated timing) ·
    consistency · IP / device overlap
        │
        ▼
recommendation + deterministic rationale
    cited rules · the math · risk factors · adjusted amount
        │
        ▼
╔══════════════════════════════════════════════╗
║  HUMAN — approve / reject / adjust           ║
╚══════════════════════════════════════════════╝
        │
        ▼
provider call FIRST, then persist — so a failed
platform call cannot leave a phantom "paid" record
        │
        ▼
snapshot + decision + audit entry, all naming the approver
```

Ordering matters: the platform call happens before persistence, so a provider
failure never leaves a decision row claiming a payout that did not happen.

---

## 3. Multi-tenancy: what "your data is yours" means

Isolation is a product promise, so it is enforced five times over and verified
by machine. The detail lives in [`ISOLATION.md`](./ISOLATION.md); the summary:

1. **Tenant claim** in `app_metadata` (never `user_metadata` — that is
   user-editable, and reading authorization from it lets anyone self-promote).
2. **Row-level security** on every table, with `WITH CHECK` on writes so a row
   cannot be moved across the boundary. A missing claim fails closed.
3. **Request-scoped database access**, so route handlers are constrained by RLS
   rather than bypassing it with the service role.
4. **A scoped data-access layer** for background jobs, which cannot build a
   query without naming a tenant.
5. **Runtime partitioning** — per-tenant credential keys, provider token caches,
   Redis namespaces, and cross-account scans.

Two checks answer different questions. `verify-isolation.sh` asks *does
isolation hold* — it builds a real Postgres and tries to break out.
`check-isolation.mjs` asks *will it still hold tomorrow* — it fails the build on
the four edits that historically erode it.

Isolation does not fail in one dramatic commit. It decays through ordinary
Friday-afternoon changes. That is why the guard exists.

---

## 4. The rule pack: why parameters, not code

Firms do not differ in **kind**. They differ in **parameters**.

Apex trails drawdown intraday. TopStep trails it end-of-day and locks it at the
starting balance. FTMO does not trail at all. That is one primitive with three
parameter sets, not three features — and the observation generalises: firms copy
each other's risk model and adjust a number.

So the catalog is closed and the parameters are open. No firm ever supplies
code, so nothing tenant-authored is ever executed, and every pack is
schema-validated, versioned, content-hashed and immutable once it leaves draft.

Three properties came out of studying real firms, and each one would have been
missed by designing from imagination:

- **`enabled: false` means the rule does not exist**, not that its threshold is
  generous. Lucid's funded product has no daily loss limit and no consistency
  rule at all. Modelling those as very large numbers produces breach records
  that should never exist.
- **`action` is independent of the threshold.** The5ers Pro Growth *terminates*
  on a 3% daily loss; TopStep *pauses trading* on its equivalent. Same rule,
  same basis, different consequence.
- **Rules are scoped by account phase.** Tradeify enforces a 40% consistency
  rule during evaluation and drops it once funded. A rule that is
  unconditionally on is wrong for most of the market.

One more, easy to get wrong: asset class does **not** imply drawdown mode.
Futures firms cluster on trailing and forex on static — but The5ers runs a
trailing model on a forex product, so the two must stay independent parameters.

### Versioning

A pack that has left draft is immutable. Editing an active pack would silently
rewrite the rules that past decisions were made under, so every change forks a
new version, and every breach decision pins the version that produced it. That
is what lets a decision stay explicable years later.

At most one pack is active per tenant per asset class, enforced by a database
constraint rather than application code — because "which rules applied?" must
have exactly one answer at the moment a trader disputes a termination.

---

## 5. The staged launch

Anyone can buy. The gate is not on purchase, it is on **enforcement**.

A firm self-serves everything — signup, credentials, presets, tuning, backtest —
with zero risk, because none of it enforces. While
`enforcement_approval_required` is set on a tenant, the single act of activating
a pack additionally needs a platform operator to have read that firm's backtest
reconciliation.

The reasoning is worth stating plainly: **gating with sales calls buys less
safety than it appears to.** A call does not catch a wrong trailing-drawdown
parameter. A backtest does. So the review is gated on the artifact that actually
contains the answer, it takes minutes rather than an hour, and it is removed per
tenant once a firm's rulebook is established.

Sign-off is per pack *version*, with the backtest id the reviewer read recorded
alongside — otherwise "we reviewed this" is unfalsifiable at exactly the moment
it matters. It is additive to the backtest, never a substitute: a signed pack
that would miss a real breach is still refused.

---

## 6. What I would build next, in order

Everything below is opinion, ranked by how much it changes the business rather
than how interesting it is to build.

> Written before items 1 (the trader-facing view) and 4 (dispute mode) were
> built. Both have since shipped; the argument for each is kept here because it
> is the reason they are shaped the way they are. Items 2, 3 and 5 are still
> open.

### 1. The trader-facing view — highest leverage, not yet built

Today the entire product is operator-facing. The firm sees everything; the
trader sees an email after the fact.

Give each trader a read-only page showing their own account against their own
firm's rules, live: current distance to the daily loss limit, where the drawdown
floor sits and whether it has locked, days traded, consistency position.

Three reasons this is the most valuable unbuilt thing:

- **Most disputes are surprise, not disagreement.** A trader who watched the
  floor move all week does not file a chargeback when it is hit.
- **It reverses the sales motion.** Traders start asking firms for it. A risk
  system the firm's own customers demand is a very different product from one
  the firm's ops team tolerates.
- **It is nearly free.** The evaluation already computes every number. This is a
  read-only projection of state that exists.

### 2. Streaming ingestion for intraday-trailing firms

Polling is wrong for Apex-style intraday trailing, and quietly so: the floor
moves on peaks that occur between polls and never appear in the closed-trade
tape. The engine is honest about this today — it reports `indeterminate` rather
than silently applying the laxer end-of-day model — but "we cannot evaluate your
main rule" is not a product.

Provider realtime feeds (BrandSocket, Rithmic PnL, SignalR) replace the poll.
Until then, be explicit at sale: intraday-trailing firms need snapshot ingestion.

### 3. Rule-pack diff and impact preview

When a firm edits v1 → v2, show two things before they publish: what changed in
plain language, and **which currently-open accounts would change status** under
the new rules. Changing a drawdown from 5% to 4% is one keystroke that can
breach forty funded accounts. Nobody should discover that afterwards.

### 4. Dispute mode

A first-class flow: trader disputes → the case opens with the evidence pack
already attached → the firm records a resolution → the outcome joins the audit
chain. Firms are being pushed toward independent dispute resolution; being the
system that already produces the file is a strong position.

### 5. Verify the presets against live rulebooks

The seven shipped presets were built from research, not from firms' published
terms, and terms change. A stale preset applied as-is breaches accounts against
rules nobody agreed to — worse than shipping no preset. They are drafts until
someone checks each against the source and records when.

---

## 7. What makes this defensible

Not the detector. Anyone can compute a trailing drawdown.

**The evidence archive.** After two years, a firm's decision history lives here:
hash-chained, versioned against the exact rules in force at the time, naming the
human who approved each one. Leaving means losing the ability to defend past
decisions. That is real lock-in, and it is earned rather than coercive — the
firm keeps the value it accumulated.

**The rule library.** Every firm onboarded teaches the schema something. After
fifty, the catalog covers the market and a new firm recognises itself in a
preset. Competitors would have to relearn that from scratch, one onboarding call
at a time.

**Published pricing.** Small, and it will be copied. But in a market where every
vendor hides prices behind a sales call, being the one that does not is a
position — and it is only credible because the backtest lets a firm self-qualify
without talking to anyone.

---

## 8. Honest current state

The multi-tenant build in this repository has not yet run in production. An
earlier single-tenant version of this engine ran against live funded accounts
at a firm that is not named here; the tenancy layer, the rule-pack engine and
the reports are newer, and are verified — a green test suite, a machine-checked
isolation suite, deterministic golden vectors — but verified is not the same as
proven in production.

Before a first paying customer:

- **Only 2 of 10 provider adapters are real** (MatchTrader, Tradovate). The other
  eight are well-researched stubs. Sell the two; waitlist the rest and say so on
  the pricing page.
- **The presets are drafts.** See §6.5.
- **Nothing is deployed.** There is no hosted instance; see
  [`SELF-HOSTING.md`](../../docs/SELF-HOSTING.md) to run one.
- **Intraday-trailing needs snapshot ingestion** to be fully evaluable. See §6.2.

The failure mode to watch for is not a crash. It is a scan that reports success
while doing nothing — which is exactly what the fraud hunter did for months,
silently discarding every finding because a unique index had moved beneath it.
Every background job should be able to say what it *could not* do, and every
number on a dashboard should be traceable to a decision that names its inputs.
