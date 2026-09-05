# Skill: rule-pack authoring

**Use when:** editing `risk-management/src/lib/rulepack/` (schema, evaluate,
primitives, presets, store), adding or changing a primitive, drafting or
touching a preset, or authoring a rule pack JSON config for a firm. A breach
decision is money and legal exposure — get the semantics wrong here and a
real funded account gets terminated on a rule that never should have fired.

Full model and reasoning: `risk-management/docs/HOW-IT-WORKS.md` §4, schema
source of truth: `risk-management/src/lib/rulepack/schema.ts`.

## The thesis

Firms differ in **parameters**, not in **kind**. The catalog of primitives
(`RULE_IDS` in `schema.ts`: `daily_loss`, `drawdown`, `consistency`,
`min_trading_days`, `inactivity`, `position_limit`, `overnight_holding`,
`weekend_holding`, `news`, `hft`, `martingale`, `grid`, `copy_trading`) is
closed. No firm ever supplies code — every pack is JSON, schema-validated,
versioned, and content-hashed. Adding a genuinely new *kind* of rule means
adding a primitive to this catalog; it is not something a per-tenant config
can express, and that's deliberate — nothing tenant-authored is ever
executed.

## `enabled: false` semantics

`enabled: false` and the rule being **absent from the pack** mean exactly the
same thing: the rule does not exist for this firm. It is not a generous
threshold, not an always-passing rule, not a zero. Lucid's funded product has
no daily loss limit at all — modelling that as `enabled: true` with a huge
threshold produces breach evaluations that assert something about a rule the
firm never agreed to. When you touch `evaluate.ts` or a primitive, verify
that a disabled/absent rule produces *no decision entry at all* for that
rule, not a passing one — see `golden-vectors.test.ts`: `'produces no
daily-loss decision when the firm has no such rule'` and `'enabled:false is
honoured exactly like omission'`.

## Phase scoping

`applies_to_phases: AccountPhase[]` (`challenge | verification | funded`)
scopes a rule to part of an account's life. Tradeify enforces a 40%
consistency rule during evaluation and drops it once funded — a rule that
is unconditionally on is wrong for most of the market. When adding a
primitive, always thread the account's current phase through to the
evaluator and filter on `applies_to_phases` before running the rule at all;
do not special-case phase inside the primitive's math.

## Action independence

`action: 'terminate' | 'pause_trading' | 'flag_for_review' | 'warn'` is a
separate field from the threshold and the basis, not derived from severity.
The5ers Pro Growth *terminates* on a 3% daily loss; TopStep *pauses* on its
equivalent — same rule, same basis, different consequence. Never infer
`action` from how far over the limit an account is; it is a firm's
configuration choice, full stop.

## Threshold types

```ts
z.discriminatedUnion('type', [
  { type: 'pct_of_initial', value: number },   // fraction of 0 < v <= 1
  { type: 'pct_of_current', value: number },
  { type: 'fixed', value: number },
])
```

Percentages are **fractions**: `0.05` is 5%. The schema refuses anything
above `1` rather than trusting the caller to have picked the convention —
mixing fraction and percentage is the classic 100x error in this domain.
Never accept or emit a raw percentage number (`5` meaning "5%") anywhere in
this path.

## Session config

A trading "day" is a firm-defined window, not a UTC calendar date
(`sessionSchema`: `timezone`, `day_start`, `week_start`). The CME session
for Monday opens 17:00 ET Sunday — a trade at 18:00 Sunday belongs to
Monday's daily-loss bucket. Getting the session boundary wrong silently
attributes losses to the wrong day and produces breaches (or non-breaches)
that shouldn't exist. `session.ts` (`sessionDayKey`) is the one place this
logic lives; do not re-derive session boundaries inline in a primitive.

Also: **asset class does not imply drawdown mode.** Futures firms cluster on
trailing, forex on static — but The5ers runs a trailing model on a forex
product. Keep `asset_class` and `drawdown.mode` independent parameters; never
gate one off the other.

## Versioning and immutability

A pack that has left `draft` status is **immutable**
(`risk-management/src/lib/rulepack/store.ts`). Editing an active pack in
place would silently rewrite the rules a past decision was made under. Every
change forks a new version; every breach decision pins the pack version and
content hash that produced it (`packVersionKey()`). If you need to "fix" an
active pack, the correct action is publishing a new version, never an
`UPDATE` on the stored row — the store throws if you try.

## Presets must carry source + `verifiedAt`

Every entry in `risk-management/src/lib/rulepack/presets.ts` carries a
`provenance: { source: string | null; verifiedAt: string | null }`. A preset
is a claim about somebody else's published rules, and firms revise those
without telling anyone — the risk isn't a wrong preset on day one, it's one
that silently stops being right while still carrying the authority of a
shipped default. `verifiedAt: null` means unverified; a preset with a
`verifiedAt` older than 90 days reads as `stale`, not `verified`
(`presetConfidence()`). Never mark a preset `verified` without a human
actually checking it against the firm's current published terms and setting
`verifiedAt` to that date. A test (`presets.test.ts`) asserts all shipped
presets are unverified by default — if you're adding a preset, don't try to
make it pass as verified.

## Verification — golden vectors and a backtest

```bash
cd risk-management && npx vitest run src/lib/rulepack/golden-vectors.test.ts
cd risk-management && npx vitest run src/lib/rulepack/backtest.test.ts
cd risk-management && npx vitest run src/lib/rulepack/            # everything in the engine
cd risk-management && npm run typecheck && npm run lint
```

Golden vectors (`golden-vectors.test.ts`) are a fixed trade tape against a
fixed pack producing an exact, hand-checked breach set — the closest thing
this product has to a proof of correctness, because a wrong breach decision
is somebody's account and somebody's money. If a change to a primitive moves
one of these, that is either a deliberate semantics change (edit the
expectation in the same commit, and say why) or a regression — never adjust
an expectation to make a change pass without first deciding which one it is.

The backtest (`backtest.ts`, §5 of `docs/TAILORING.md`) replays a firm's own
recent history through its pack with nothing enforcing, and is the mechanism
that makes activation safe: a run that missed a breach the firm's own
platform caught is blocking, unconditionally, and a run where any rule
could not be evaluated is also blocking — "no breach" and "not checked" must
never read the same. When you change evaluation logic, re-run the backtest
suite, not just the golden vectors — it exercises the reconciliation path the
vectors don't.

## Common mistakes

- Treating a large threshold as a stand-in for "no rule" instead of omitting
  or disabling the rule.
- Deriving `action` from severity or from the threshold instead of reading
  it as an independent config field.
- Computing session-day boundaries with `new Date().toISOString().slice(0,
  10)` or similar UTC-calendar-day logic instead of `sessionDayKey()`.
- Editing a `StoredRulePack` row directly in a migration or script instead of
  publishing a new version.
- Shipping a new preset marked `verified` from research rather than from a
  checked, dated source.
- Using a percentage where a fraction is expected (or vice versa) — the
  schema catches `> 1`, but a preset author can still supply `0.5` meaning
  "0.5%" instead of 50%; sanity-check against the firm's real numbers.
