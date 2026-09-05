# Prompt: tailor PropRisk to my firm

Fill in the placeholders, paste the block into a coding agent with access to your
clone, and it will write your rule pack, brand the app, connect your platform,
run the backtest and report the reconciliation.

It will **not** activate anything. Activation is a decision a person makes after
reading the reconciliation, and no prompt should take that away from you.

## Fill these in first

| Placeholder | What to put | Example |
|---|---|---|
| `{{FIRM_NAME}}` | Your firm's name | `Northwind Futures` |
| `{{RULEBOOK_URL}}` | The page where your current rules are published | `https://example.com/rules` |
| `{{ASSET_CLASS}}` | `futures` or `forex` | `futures` |
| `{{PLATFORM}}` | Your trading platform | `tradovate` |
| `{{DRAWDOWN_MODE}}` | `static`, `trailing_eod` or `trailing_intraday` | `trailing_eod` |
| `{{DRAWDOWN_PCT}}` | As a fraction. 4% is `0.04` | `0.04` |
| `{{DRAWDOWN_LOCK}}` | `never`, `at_initial_balance` or `at_initial_plus` | `at_initial_balance` |
| `{{DAILY_LOSS_PCT}}` | Fraction, or `none` if you have no daily loss limit | `0.02` |
| `{{DAILY_LOSS_BASIS}}` | `balance`, `equity` or `highest_equity_of_day` | `equity` |
| `{{DAILY_LOSS_ACTION}}` | `terminate`, `pause_trading`, `flag_for_review` or `warn` | `pause_trading` |
| `{{CONSISTENCY_PCT}}` | Fraction, or `none` | `0.4` |
| `{{CONSISTENCY_PHASES}}` | Which phases it applies to, or `none` | `challenge, verification` |
| `{{MIN_TRADING_DAYS}}` | A number, or `none` | `3` |
| `{{SESSION_TIMEZONE}}` | IANA zone | `America/New_York` |
| `{{SESSION_DAY_START}}` | `HH:MM`. `00:00` means calendar days | `17:00` |
| `{{POSITION_LIMITS}}` | Starting balance to maximum size, or `none` | `50000:10, 100000:14` |
| `{{BRAND_NAME}}` | Product name in the UI | `Northwind Risk` |
| `{{BRAND_ACCENT}}` | Accent hex, or `default` | `#1d4ed8` |

`none` is a real answer. A rule you leave out does not exist for your firm, which
is different from a generous threshold — see
[`../TAILORING.md`](../TAILORING.md#1-write-your-rule-pack).

---

```text
ROLE
You are configuring PropRisk for {{FIRM_NAME}}. Everything a firm changes is
configuration. You are not modifying the rule engine, and if a rule cannot be
expressed with the existing primitives, you stop and say so rather than adding
code.

READ FIRST
- docs/TAILORING.md          how to express a rulebook as a pack
- docs/BUILD-SPEC.md §4      the rule-pack contract and all 13 primitives
- {{RULEBOOK_URL}}           the firm's own published rules — the authority

THE FIRM
  name             {{FIRM_NAME}}
  asset class      {{ASSET_CLASS}}
  platform         {{PLATFORM}}
  session          {{SESSION_TIMEZONE}}, day starts {{SESSION_DAY_START}}
  drawdown         {{DRAWDOWN_MODE}} at {{DRAWDOWN_PCT}}, lock {{DRAWDOWN_LOCK}}
  daily loss       {{DAILY_LOSS_PCT}} on {{DAILY_LOSS_BASIS}}, action {{DAILY_LOSS_ACTION}}
  consistency      {{CONSISTENCY_PCT}} during {{CONSISTENCY_PHASES}}
  min trading days {{MIN_TRADING_DAYS}}
  position limits  {{POSITION_LIMITS}}

TASKS, in order

1. WRITE THE RULE PACK
   Start from the closest preset (GET /api/rulepack/presets), then set every
   parameter above. Rules I marked `none` must be ABSENT from the pack, not
   present with a large threshold.
   - Percentages are fractions: 0.04 means 4%.
   - `action` is independent of the threshold. Use exactly what I gave you.
   - Scope rules to phases where I said so; do not leave a rule unconditionally
     on because that was the preset's default.
   - Read {{RULEBOOK_URL}} and CHECK MY NUMBERS against it. If the published
     rules disagree with what I wrote above, STOP and show me both. Do not
     silently prefer either one.
   Create it as a draft: POST /api/rulepack.

2. VALIDATE
   The pack must pass schema and semantic validation. If validation fails,
   report the exact error and what in the rulebook it corresponds to. Do not
   loosen a parameter to make an error go away.

3. BRAND
   Set NEXT_PUBLIC_BRAND_NAME={{BRAND_NAME}} and, unless it is `default`,
   NEXT_PUBLIC_BRAND_ACCENT={{BRAND_ACCENT}} in .env.local. Read DESIGN.md
   before touching any component; do not restyle anything to accommodate the
   brand colour.

4. CONNECT THE PLATFORM
   Add a {{PLATFORM}} connection at /connections using credentials I supply —
   never invent, never commit, never echo a credential back to me in full.
   Then run POST /api/connections/{{PLATFORM}}/validate and report the result.
   If {{PLATFORM}} is one of the eight stub adapters, STOP and tell me: it needs
   an implementation before anything can be monitored, and pretending otherwise
   produces empty results that read as "no breaches".

5. BACKTEST
   POST /api/rulepack/<id>/backtest against our own recent history.
   Report, in this order:
     - providerOnly  breaches our platform enforced that this pack MISSED.
                     Every one of these BLOCKS activation. For each, say which
                     parameter is wrong and what it should be.
     - skipped       rules that could not be evaluated, and why. These also
                     block. If a rule needs equity snapshots, say so plainly.
     - engineOnly    breaches this pack found that our platform did not. Not
                     blocking, but tell me which look like genuine catches and
                     which look like a mis-set parameter.
     - agreed        the count.

6. DO NOT ACTIVATE
   Stop after the backtest. Tell me what activation would require, and what is
   currently blocking it. Activating a rule pack terminates real funded
   accounts; that is my decision, made after reading your report.

CONSTRAINTS
- Never guess a threshold. If the rulebook is ambiguous, quote the ambiguous
  sentence and ask.
- Never modify src/lib/rulepack/schema.ts or any primitive. If our rules cannot
  be expressed, that is a finding to report, not a patch to write.
- Never commit a .env file or a credential.
- Report what you actually ran and what it actually returned.
```
