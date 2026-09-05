# Architecture

Three diagrams: what the system is made of, what happens to a single request,
and what happens to a single breach. Everything below describes code that is in
this repository — file paths are given so a diagram can be checked against the
thing it claims to describe.

For the reasoning behind these shapes, read
[`risk-management/docs/HOW-IT-WORKS.md`](../risk-management/docs/HOW-IT-WORKS.md).
For the isolation model, read
[`risk-management/docs/ISOLATION.md`](../risk-management/docs/ISOLATION.md).

---

## 1. System context

One deployment serves every firm. A firm's data is separated inside the
database rather than by giving each firm its own database, which is what makes
self-serve signup possible at all — a per-firm deployment cannot be created by
someone filling in a form.

```mermaid
flowchart TB
    subgraph people[" "]
        direction LR
        ops["Risk manager<br/>(a firm's own staff)"]
        trader["Trader<br/>(tokenized link, no account)"]
        operator["Platform operator<br/>(staged-launch review)"]
    end

    subgraph app["Next.js 14 application — one deployment, many firms"]
        direction TB
        mw["middleware.ts<br/>deny-by-default auth"]
        pages["Server components<br/>src/app/(dashboard|marketing|trader)"]
        api["Route handlers<br/>src/app/api (~100 routes)"]
        crons["Cron routes<br/>src/app/api/cron/** (9 jobs)"]
        engine["Rule-pack engine<br/>src/lib/rulepack — pure, deterministic"]
        adapters["Provider adapters<br/>src/lib/providers — 10, of which 2 live"]
        reports["Report renderers<br/>PDF + CSV, deterministic"]
    end

    subgraph data["State"]
        pg[("Supabase Postgres<br/>row-level security on every table")]
        redis[("Upstash Redis — optional<br/>rate limits, per-tenant queues")]
    end

    subgraph outside["Third parties"]
        platforms["Trading platforms<br/>MatchTrader · Tradovate"]
        stripe["Stripe — optional"]
        mail["Resend / Gmail — optional"]
    end

    ops --> mw
    trader --> mw
    operator -->|PLATFORM_ADMIN_SECRET| api
    mw --> pages
    mw --> api
    api --> engine
    api --> reports
    crons --> engine
    crons --> adapters
    engine --> pg
    reports --> pg
    adapters --> platforms
    api --> pg
    api --> redis
    api --> stripe
    api --> mail
    pages --> pg
```

Notes worth reading off the diagram:

- **The engine has no I/O.** `src/lib/rulepack/evaluate.ts` is a pure function
  from (pack, inputs) to decisions. Everything that talks to the world is
  outside it, which is why a backtest can be the identical call.
- **Traders never get a session.** The token in their URL is verified
  server-side on every request (`src/lib/trader/tokens.ts`) and resolves to
  exactly one (tenant, account) pair.
- **The platform operator is not a customer role.** Staged-launch review is
  gated on a separate shared secret in `middleware.ts`, so no tenant session —
  including a compromised owner account — can reach it.

---

## 2. Request path, and where isolation is enforced

The five layers are not five checks in one place; they are five different
mechanisms that would each have to fail. This diagram shows where each sits on
the path of a single request.

```mermaid
flowchart TD
    req["HTTP request"] --> mw{"middleware.ts"}

    mw -->|"/api/cron/*"| cronsec{"Bearer CRON_SECRET"}
    mw -->|"/api/platform-admin/*"| adminsec{"Bearer PLATFORM_ADMIN_SECRET"}
    mw -->|"public allowlist<br/>src/lib/auth/public-routes.ts"| public["Marketing, signup,<br/>Stripe webhook, trader links"]
    mw -->|"everything else"| session{"Supabase session?"}

    cronsec -->|no| deny401["401"]
    adminsec -->|no| deny401
    session -->|no| deny401

    session -->|yes| guard["LAYER 1 — the tenant claim<br/>src/lib/auth/guards.ts<br/>role + tenant_id read from app_metadata only"]
    guard -->|"no tenant claim"| deny403["403 — a tenantless session<br/>is unusable, not global"]
    guard -->|"claim present"| scoped["LAYER 3 — request-scoped DB client<br/>src/lib/supabase/server.ts<br/>anon key + the user's cookies"]

    scoped --> rls["LAYER 2 — row-level security<br/>USING (tenant_id = auth_tenant_id())<br/>WITH CHECK on every write"]

    cronsec -->|yes| fanout["fanOutToTenants()<br/>src/app/api/cron/_lib/fanout.ts"]
    fanout --> dal["LAYER 4 — the scoped DAL<br/>src/lib/db/tenant-scoped.ts<br/>no query builder without a tenant id"]
    dal --> service["service_role connection<br/>(BYPASSRLS — RLS is NOT the guard here)"]

    rls --> pg[("Postgres")]
    service --> pg

    pg --> runtime["LAYER 5 — runtime partitioning<br/>per-tenant credential keys, provider token<br/>caches, Redis namespaces, ring scans"]
    runtime --> resp["Response"]
    public --> resp
```

Two facts this diagram is drawn to make obvious:

- **Route handlers and background jobs are protected by different layers.** A
  route is constrained by RLS because it connects as the signed-in user. A cron
  has no session, must use the service role, and is therefore constrained only
  by the scoped data-access layer. Confusing the two is how a leak gets written.
- **`auth_tenant_id()` returns NULL when the claim is absent**, and
  `tenant_id = NULL` is NULL rather than TRUE, so every policy fails closed. A
  token with no tenant claim sees nothing at all.

`node risk-management/scripts/check-isolation.mjs` fails the build on the four
edits that historically erode this; `risk-management/supabase/tests/verify-isolation.sh`
builds a real Postgres and tries to break out of it.

---

## 3. The breach flow

From an ingested trade to an enforced action. The human step in the middle is
the product, not a stage that automation has not reached yet.

```mermaid
sequenceDiagram
    autonumber
    participant Cron as cron/detect-violations
    participant Prov as Provider adapter
    participant Eng as Rule-pack engine
    participant DB as Postgres
    participant Ops as Risk manager
    participant Trader

    Cron->>DB: listActiveTenantIds()
    loop per tenant, concurrency 3
        Cron->>DB: activePack(tenant, assetClass)
        Cron->>Prov: accounts, trades, equity snapshots
        Prov-->>Cron: normalized data
        Cron->>Eng: evaluateRulePack(pack, input, packVersion)
        Eng-->>Cron: decisions[] + skipped[]

        Note over Eng,Cron: skipped is NOT a pass.<br/>A rule with missing inputs<br/>reports why it could not run.

        Cron->>DB: INSERT breach_decisions (idempotency_key)
        Cron->>DB: INSERT violations, linked to the enforcement item
        Cron->>DB: INSERT enforcement_queue (status = pending)
        Cron->>DB: buildEvidencePack() — trade tape, rule as written,<br/>arithmetic, related accounts, prior decisions
        Cron->>DB: draftTraderNotice() — drafted, never sent
        Cron->>DB: violation_reports payload (PDF/CSV source of truth)
    end

    Ops->>DB: read the queue, the evidence, the arithmetic
    alt approve
        Ops->>Prov: enforce(accountId, restrict | suspend | flatten)
        Prov-->>Ops: result
        Ops->>DB: audit_log entry naming the approver (hash-chained)
        Ops->>Trader: notice sent, with a link to the decision record
    else reject or modify
        Ops->>DB: audit_log entry naming the approver and the reason
    end

    opt the trader disagrees
        Trader->>DB: dispute opened
        Note over DB: the evidence pack is PINNED as it stood<br/>at decision time, not re-scored under<br/>whatever rules are current now
        Ops->>DB: resolution — upheld or overturned, joins the audit chain
    end
```

The ordering in the payout flow is the mirror image and matters just as much:
the provider call happens **before** persistence, so a failed platform call can
never leave a decision row claiming a payout that did not happen.
