# Tailoring PropRisk to your firm

Everything a firm changes is configuration. You should not need to fork the
engine to encode your rulebook, and if you do, that is a gap in the primitive
catalog worth opening an issue about — not something to patch locally.

This guide covers, in the order you will need them:

1. [Write your rule pack](#1-write-your-rule-pack)
2. [The rule-to-primitive map](#2-the-rule-to-primitive-map)
3. [Brand the app](#3-brand-the-app)
4. [Connect your trading platform](#4-connect-your-trading-platform)
5. [Backtest, and what "blocking" means](#5-backtest-and-what-blocking-means)
6. [The staged-launch gate](#6-the-staged-launch-gate)
7. [Support inbox](#7-support-inbox)
8. [Trader links](#8-trader-links)
9. [Reports](#9-reports)
10. [Keep your presets verified](#10-keep-your-presets-verified)
11. [Deploy](#11-deploy)

---

## 1. Write your rule pack

Start from a preset at `/rules/new`, then change the numbers. A preset is a
starting **shape**, not a claim about a firm's current terms — see §10.

Here is a complete pack, annotated with the things that are easy to get wrong.
The comments are for reading; strip them before posting, since the stored pack is
plain JSON.

```jsonc
{
  "schema_version": 1,

  // Descriptive ONLY. Asset class does not imply drawdown mode: futures firms
  // cluster on trailing and forex on static, but The5ers runs a trailing model
  // on a forex product. Keep the two independent.
  "asset_class": "futures",

  "name": "House Rules",

  // A "day" is YOUR day, not a UTC date. The CME session for Monday opens at
  // 17:00 ET on Sunday, so a trade at 18:00 Sunday belongs to Monday's
  // daily-loss bucket. Use "00:00" if you genuinely mean calendar days —
  // most forex firms do.
  "session": {
    "timezone": "America/New_York",
    "day_start": "17:00",
    "week_start": "sunday"
  },

  "rules": {
    "drawdown": {
      "enabled": true,

      // static            floor fixed at open, never moves
      // trailing_eod      floor follows the day's CLOSE
      // trailing_intraday floor follows every new equity high — the harshest,
      //                   and the one that needs equity snapshots (§4)
      "mode": "trailing_eod",

      // Where a trailing floor STOPS trailing. Without a lock, a profitable
      // account is never further from breach than a brand-new one.
      "lock": "at_initial_balance",   // never | at_initial_balance | at_initial_plus
      // "lock_buffer": 1000,         // required only for at_initial_plus

      "basis": "equity",              // balance = realised only; equity includes open

      // FRACTIONS, not percentages. 0.04 is 4%. The schema refuses anything
      // above 1, because 4 meaning 400% is the classic error here.
      "threshold": { "type": "pct_of_initial", "value": 0.04 },

      "applies_to_phases": ["challenge", "verification", "funded"],

      // Independent of the threshold. Two firms can share a limit and differ
      // entirely in what happens when it is hit.
      "action": "terminate"           // terminate | pause_trading | flag_for_review | warn
    },

    "daily_loss": {
      "enabled": true,
      // balance               realised only, measured from the prior close
      // equity                realised + open
      // highest_equity_of_day the intraday high-water mark — the harshest basis,
      //                       and it REQUIRES equity snapshots
      "basis": "equity",
      "include_open_pnl": true,
      "threshold": { "type": "pct_of_initial", "value": 0.02 },
      "applies_to_phases": ["challenge", "verification", "funded"],
      "action": "pause_trading"
    },

    "consistency": {
      "enabled": true,
      "max_best_day_pct_of_profit": 0.4,   // no day may be more than 40% of profit
      "evaluated_at": "payout",            // payout | continuous
      "min_profit_to_evaluate": 0,
      // The instructive part: this rule governs the evaluation and is DROPPED
      // once funded. A rule that is unconditionally on is wrong for most firms.
      "applies_to_phases": ["challenge", "verification"],
      "action": "flag_for_review"
    },

    "min_trading_days": {
      "enabled": true,
      "min_days": 3,
      "count_basis": "profitable",         // any_trade | profitable — not the same thing
      "applies_to_phases": ["challenge", "verification"],
      "action": "flag_for_review"
    },

    "position_limit": {
      "enabled": true,
      "mode": "by_account_size",           // by_account_size | fixed
      // A size that is absent here is an ERROR at authoring time, not a silent
      // default. An account policed against a number nobody chose is worse
      // than an account not policed at all.
      "limits_by_size": { "50000": 10, "100000": 14, "150000": 17, "250000": 27 },
      "applies_to_phases": ["challenge", "verification", "funded"],
      "action": "flag_for_review"
    },

    "overnight_holding": {
      "enabled": true,
      "flat_by": "16:59",                  // wall clock in the SESSION timezone
      "applies_to_phases": ["challenge", "verification", "funded"],
      "action": "flag_for_review"
    }

    // Rules you do not want are ABSENT. Omission and "enabled": false mean the
    // same thing: the rule does not exist for your firm. That is different from
    // a generous threshold — a very large daily loss limit produces breach
    // records for accounts that were never subject to the rule at all.
  }
}
```

### The three properties to internalise

1. **`enabled: false` means the rule does not exist.** Some funded products
   genuinely have no daily loss limit and no consistency rule. Modelling those as
   very large numbers produces phantom breaches.
2. **`action` is independent of the threshold.** One firm terminates on a 3%
   daily loss; another pauses trading on the same number. Same rule, same basis,
   different consequence.
3. **Rules are scoped by phase.** A consistency rule that applies during
   evaluation and is dropped once funded is a normal shape, not an exception.

### Lifecycle

`draft → testing → active → archived`. A pack past `draft` is **immutable** —
editing it would rewrite the rules a past decision was made under. Change it by
forking a new version (`POST /api/rulepack/[id]/promote`), which bumps the
version for the same `(tenant, name)` so every past decision still names the
rules it was made under. At most one pack is active per asset class, enforced by
a database constraint.

Before publishing v2, look at two things the product will show you:
`GET /api/rulepack/[id]/diff` (what changed, in plain language) and
`GET /api/rulepack/[id]/impact` (which currently-open accounts change status
under the new rules). Tightening a drawdown from 5% to 4% is one keystroke that
can breach forty funded accounts.

---

## 2. The rule-to-primitive map

Typical prop-firm rules, and how to express them.

| Your rule reads like | Primitive | Parameters |
|---|---|---|
| "Maximum loss of 5% in one day" | `daily_loss` | `basis: 'balance'`, `threshold: pct_of_initial 0.05` |
| "5% daily loss including open trades" | `daily_loss` | `basis: 'equity'`, `include_open_pnl: true` |
| "Daily loss measured from your highest equity that day" | `daily_loss` | `basis: 'highest_equity_of_day'` — **needs equity snapshots** |
| "$2,500 daily loss limit" | `daily_loss` | `threshold: fixed 2500` |
| "10% maximum drawdown from the starting balance" | `drawdown` | `mode: 'static'`, `lock: 'never'`, `basis: 'balance'` |
| "Trailing drawdown that follows your account high" | `drawdown` | `mode: 'trailing_intraday'` — **needs equity snapshots** |
| "Trailing drawdown that updates at the end of each day" | `drawdown` | `mode: 'trailing_eod'` |
| "The trailing stops once you are $X in profit" | `drawdown` | `lock: 'at_initial_balance'`, or `at_initial_plus` with `lock_buffer` |
| "No single day may exceed 40% of total profit" | `consistency` | `max_best_day_pct_of_profit: 0.4`, `evaluated_at: 'payout'` |
| "Minimum 5 trading days" | `min_trading_days` | `min_days: 5`, `count_basis: 'any_trade'` |
| "Minimum 3 profitable days" | `min_trading_days` | `count_basis: 'profitable'` |
| "Accounts idle for 30 days are closed" | `inactivity` | `max_idle_days: 30` |
| "Maximum 14 contracts on a $100k account" | `position_limit` | `mode: 'by_account_size'`, `limits_by_size` |
| "Maximum 5 lots, any account" | `position_limit` | `mode: 'fixed'`, `fixed_limit: 5` |
| "Half size on crypto" | `position_limit` | `per_symbol_class: { "crypto": 0.5 }` |
| "Flat by 4:59pm ET" | `overnight_holding` | `flat_by: '16:59'` |
| "No positions over the weekend" | `weekend_holding` | `flat_by` at your Friday close |
| "No trading 2 minutes either side of high-impact news" | `news` | `before_minutes: 2`, `after_minutes: 2`, `impact_levels: ['red']` |
| "No high-frequency trading" | `hft` | `windows: [{ window_seconds: 10, max_trades: 3 }, …]` |
| "No martingale" | `martingale` | `min_losing_streak: 2`, `volume_multiplier: 1.5` |
| "No grid trading" | `grid` | window, lot tolerance, minimum matched trades, score threshold |
| "No copy trading between accounts" | `copy_trading` | lag window, lot tolerance, minimum copied trades, score |

**If your rule is not here**, check whether it is one of these with different
parameters before concluding it is missing. If it genuinely is not expressible,
open an issue with the rulebook text — the catalog is meant to grow by
primitives, not by tenant-specific code.

Two rules behave differently from the rest: `grid` and `copy_trading` compare
accounts against each other, so they are evaluated in a separate per-tenant pass
rather than per account. The per-account result reports them as `skipped` with
that reason, which is expected and not a gap.

---

## 3. Brand the app

All optional; unset values fall back to an unbranded look.

| Variable | Effect |
|---|---|
| `NEXT_PUBLIC_BRAND_NAME` | Product name in the sidebar, login, emails, browser tab |
| `NEXT_PUBLIC_BRAND_COMPANY` | Company line under the product name |
| `NEXT_PUBLIC_BRAND_TAGLINE` | Metadata description |
| `NEXT_PUBLIC_BRAND_LOGO_URL` | Absolute URL preferred — bundled assets are shared by every deployment built from this repo |
| `NEXT_PUBLIC_BRAND_FAVICON_URL` | Absolute URL |
| `NEXT_PUBLIC_BRAND_ACCENT` | Accent hex; overrides the `--accent-red` custom property |
| `NEXT_PUBLIC_BRAND_NEUTRAL` | Neutral hex; overrides `--silver` |
| `BRAND_EMAIL_FROM` | Verified sender address for outbound mail |
| `BRAND_EMAIL_SENDER_NAME` | Display name on outbound mail |

`NEXT_PUBLIC_*` values are inlined at build time, so they are the *deployment's*
default brand. Per-tenant branding is stored in `tenants.branding_json` and
applied at runtime, because build-time variables cannot vary per firm in a shared
deployment.

**Read [`../DESIGN.md`](../DESIGN.md) before restyling anything.** It documents
which tokens are themeable and which are structural, and it has a compliance gate
with baselines that will fail your build if you widen the raw-colour debt.

---

## 4. Connect your trading platform

Create the connection with `POST /api/connections` (the `/connections` page is a status board today; there is no credential form yet), then call `POST /api/connections/<provider>/validate`.
Validation performs a real read against the platform and records `valid` or
`invalid` with the error. Do this before you rely on anything — finding out that
a key is read-only or scoped to the wrong account group belongs in onboarding,
not in a cron run at 3am.

Credentials are envelope-encrypted per tenant: a master key in the environment
(never in the database) plus an AES-256-GCM key derived from it by HKDF salted on
your tenant id. A leaked row is useless without the master key.

**Live adapters:** MatchTrader (forex) and Tradovate (futures).

**Stubs:** DXtrade, TradeLocker, cTrader, MetaTrader 4/5, Rithmic, TopstepX
(ProjectX), CQG, NinjaTrader. Each documents its real auth, transport and access
model in the registry, and throws a `NotConfiguredError` naming what to set
rather than returning an empty list. That distinction matters: an empty list
reads as "no breaches".

### Finishing a stub adapter

1. Read `src/lib/providers/registry.ts` for that provider's `kind`, `manager`
   flag, transport and documentation URL. `manager: false` means the platform's
   API is per-trader, so firm-wide monitoring needs a key per trader — a product
   constraint you should confirm before starting.
2. Implement the `TradingProvider` methods in
   `src/lib/providers/adapters/<id>.ts`, mapping the platform's native shapes
   onto the normalized types in `src/lib/providers/types.ts`.
3. **Cache any auth token in a `Map` keyed by tenant id**, never in a
   module-scoped variable. Shared, the first firm to authenticate populates the
   module and every later firm's requests go out under that firm's token.
4. Honour the trailing optional `tenantId` on every method and resolve
   credentials with `getProviderConfig(id, tenantId)`.
5. Implement `enforce()` only if the platform's API genuinely supports restrict,
   suspend or flatten. Omitting it is correct where it does not.
6. Write tests against recorded fixtures, and prove the token cache is
   partitioned. The existing MatchTrader and Tradovate tests are the pattern.

### Equity snapshots

`trailing_intraday` drawdown and `highest_equity_of_day` daily loss cannot be
computed from closed trades alone — the peak occurs while a position is open and
never appears in the tape. Supply samples either way:

- **Push:** `POST /api/ingest/equity-snapshots` with a per-tenant ingest key.
- **Poll:** enable the `sample-equity` cron.

The sampling interval is stored alongside every sample, so a breach derived from
sparse data can say so. Without snapshots those rules report `skipped` with a
reason — never a pass, and never a quiet downgrade to the more forgiving
end-of-day model.

---

## 5. Backtest, and what "blocking" means

`POST /api/rulepack/[id]/backtest` replays your own recent history through the
candidate pack and reconciles the result against what your platform actually
reported. It runs the **same** evaluator the live path runs, so there is no
second implementation that could flatter production.

Three lists come back:

| List | Meaning | Blocks activation? |
|---|---|---|
| `agreed` | Both your platform and this pack found the breach | No |
| `engineOnly` | This pack found a breach your platform did not report | **No** — often the reason you are switching, but review each: some are genuine catches, some are a mis-set parameter |
| `providerOnly` | Your platform enforced a breach this pack would have **missed** | **Yes** |

Plus a `skipped` list. **Any skipped rule also blocks**, because a run that could
not evaluate a rule has not proved coverage.

`providerOnly` blocks because activating past it silently relaxes your own rules.
That is the one failure mode a risk platform must not have, so the check lives in
the activation path itself rather than in the UI — no client can talk its way
past it.

The reconciliation matches on (account, rule), not on timestamp: your platform
stamps a breach when its job noticed it and this engine stamps it when it
occurred, which legitimately differ by minutes.

---

## 6. The staged-launch gate

While `tenants.enforcement_approval_required` is true, activating a pack
additionally needs a platform operator to have read that firm's backtest
reconciliation, via `POST /api/platform-admin/rule-packs` behind
`PLATFORM_ADMIN_SECRET`.

The reasoning is worth stating plainly: **gating with sales calls buys less
safety than it appears to.** A call does not catch a wrong trailing-drawdown
parameter; a backtest does. So the review is gated on the artifact that actually
contains the answer, takes minutes rather than an hour, and is removed per tenant
once a firm's rulebook is established.

Sign-off is per pack **version**, with the backtest id the reviewer read recorded
alongside — otherwise "we reviewed this" is unfalsifiable at exactly the moment a
trader disputes a termination. It is additive to the backtest, never a
substitute: a signed pack that would miss a real breach is still refused.

**If you are self-hosting for your own firm, turn it off.** It exists for a
multi-tenant operator running a supervised first cohort:

```sql
UPDATE tenants SET enforcement_approval_required = false WHERE id = '<your-tenant-id>';
```

That column is deliberately not writable by a tenant's own admin — column
privileges on `tenants` allow `authenticated` to update only `name` and
`branding_json`, because row-level security decides which *rows* you may write,
never which *columns*.

---

## 7. Support inbox

Set `SUPPORT_INBOX_EMAIL`. Tickets raised in the app are mailed there with
diagnostics attached. Outside demo mode the support module throws if it is unset,
rather than dropping tickets into nowhere.

---

## 8. Trader links

`POST /api/accounts/[login]/trader-link` mints a link showing that trader their
own account against your rules: distance to the daily loss limit, where the
drawdown floor sits and whether it has locked, days traded, consistency position.
The numbers come from the same primitives the breach engine uses, so the page
cannot disagree with a notice.

- Only the sha256 hash of the token is stored; the raw token exists once, in the
  link you hand out.
- Default expiry is 30 days — long enough for a challenge, short enough to force
  rotation. Revoke with `DELETE` on the same route.
- The link carries no session and reaches exactly one (tenant, account) pair.

Most disputes are surprise rather than disagreement. A trader who watched the
floor move all week does not file a chargeback when it is hit.

---

## 9. Reports

Every violation has a report, rendered from a **persisted payload** rather than
recomputed from live data — because a report a trader disputes must not change
between two downloads, and the account keeps trading.

| Route | Use |
|---|---|
| `GET /api/violations/[id]/report?format=pdf` | The document you send a trader |
| `GET /api/violations/[id]/report?format=csv` | The same content as rows |
| `GET /api/violations/[id]/report?format=json` | The payload itself — what makes the other two auditable |
| `POST /api/violations/[id]/report` | Regenerate the payload after correcting upstream data |
| `GET /api/violations/account/[accountId]/report` | Account-wide CSV |
| `GET /api/trader/[token]/violations/[id]/report` | The trader's own copy |

Download buttons are on `/violations`, `/violations/[id]`,
`/violations/account/[accountId]`, `/disputes`, and the trader page.

Regeneration is an explicit `POST`, never a side effect of a `GET`, so nobody can
change a document a trader is holding by refreshing a page.

---

## 10. Keep your presets verified

Every preset carries provenance:

```ts
provenance: {
  source: 'https://example.com/rules',  // a URL a human can open and compare
  verifiedAt: null,                     // null means NOBODY HAS checked it
  verifiedBy: undefined,
}
```

Confidence is derived, not asserted: `unverified` when `verifiedAt` is null,
`stale` more than 90 days after it, `verified` otherwise. The product shows that
wherever a preset appears.

**Every preset shipped in this repository has `verifiedAt: null.`** They were
built from secondary research, not from the firms' published terms. Firms revise
terms without notice, and a stale preset applied as-is breaches accounts against
rules nobody agreed to — worse than shipping no preset, because it carries false
authority.

So: open the source, compare every threshold to your own rulebook, then set
`verifiedAt` and `verifiedBy` and re-check within 90 days. If you verify a preset
against a firm's current published terms, that is the single most useful pull
request you can send this project.

---

## 11. Deploy

**Vercel.** Import the repository, set the root directory to `risk-management`,
add the environment variables, and deploy. The nine cron schedules in
`risk-management/vercel.json` are picked up automatically. Set `CRON_SECRET` as a
project secret so the cron routes authenticate.

**Any Node host.** `npm run build && npm start`, then point an external scheduler
at the cron routes with a bearer token:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
  https://your-host/api/cron/detect-violations
```

Full instructions — migrations, every environment variable grouped by whether it
is required, secret rotation, backups, upgrades and the health endpoint — are in
[`SELF-HOSTING.md`](./SELF-HOSTING.md).
