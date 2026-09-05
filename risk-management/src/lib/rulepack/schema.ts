import { z } from 'zod';

/**
 * The Rule Pack contract.
 *
 * Every prop firm defines breaches differently, but they do not differ in
 * KIND — they differ in PARAMETERS. Apex trails drawdown intraday; TopStep
 * trails it end-of-day and locks at the starting balance; FTMO does not trail
 * at all. That is one primitive with three parameter sets, not three features.
 * This file is the closed catalog of those primitives. Firms configure them;
 * no firm ever supplies code, so nothing tenant-authored is ever executed.
 *
 * Three properties are load-bearing and were derived from how real firms
 * actually differ, not from what looked tidy:
 *
 *  - `enabled: false` means the rule DOES NOT EXIST for this firm, not that its
 *    threshold is generous. Lucid's Flex funded account has no daily loss limit
 *    and no consistency rule at all; modelling that as a very large threshold
 *    would produce breach records that should never exist.
 *
 *  - `action` is independent of the threshold. The5ers Pro Growth TERMINATES on
 *    a 3% daily loss while Hyper Growth PAUSES TRADING on its equivalent. Same
 *    rule, same basis, different consequence.
 *
 *  - `applies_to_phases` scopes a rule to part of an account's life. Tradeify
 *    enforces a 40% consistency rule during the Select evaluation and drops it
 *    entirely once funded, so a rule that is unconditionally on is wrong for
 *    most of the market.
 *
 * Evaluation is deterministic and pure. A breach decision is money and creates
 * legal exposure, so no model output ever reaches this path — LLMs draft packs
 * and explain decisions, they never make them.
 */

export const ACCOUNT_PHASES = ['challenge', 'verification', 'funded'] as const;
export const accountPhaseSchema = z.enum(ACCOUNT_PHASES);
export type AccountPhase = z.infer<typeof accountPhaseSchema>;

/**
 * What happens when the rule is broken. Kept separate from severity: severity
 * describes how bad it is, action describes what the platform does about it.
 */
export const BREACH_ACTIONS = ['terminate', 'pause_trading', 'flag_for_review', 'warn'] as const;
export const breachActionSchema = z.enum(BREACH_ACTIONS);
export type BreachAction = z.infer<typeof breachActionSchema>;

/**
 * `pct_*` values are FRACTIONS (0.05 = 5%), not percentages. Mixing the two is
 * the classic 100x error in this domain, so the schema refuses anything above
 * 1 rather than trusting the caller to have picked the same convention.
 */
export const thresholdSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pct_of_initial'), value: z.number().gt(0).max(1) }),
  z.object({ type: z.literal('pct_of_current'), value: z.number().gt(0).max(1) }),
  z.object({ type: z.literal('fixed'), value: z.number().gt(0) }),
]);
export type Threshold = z.infer<typeof thresholdSchema>;

/**
 * The trading session. A "day" is a firm-defined window, not a UTC calendar
 * date: the CME session for Monday opens 17:00 ET on Sunday, so a trade placed
 * at 18:00 Sunday belongs to Monday's daily-loss bucket. Getting this wrong
 * silently attributes losses to the wrong day and produces breaches that did
 * not happen.
 */
export const sessionSchema = z.object({
  /** IANA zone, e.g. America/New_York. Validated at parse time. */
  timezone: z.string().refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be a valid IANA timezone, e.g. America/New_York' }
  ),
  /** Wall-clock start of the trading day. '00:00' means calendar days. */
  day_start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM'),
  week_start: z.enum(['sunday', 'monday']).default('sunday'),
});
export type SessionConfig = z.infer<typeof sessionSchema>;

/** Fields every primitive carries. */
const ruleBase = {
  enabled: z.boolean(),
  applies_to_phases: z.array(accountPhaseSchema).min(1).default([...ACCOUNT_PHASES]),
  action: breachActionSchema.default('flag_for_review'),
};

// ── Account-level primitives ────────────────────────────────────────────────

export const dailyLossSchema = z.object({
  ...ruleBase,
  /**
   * What the day's loss is measured against.
   *  balance               — realized only (FTMO measures off the prior close)
   *  equity                — realized + open
   *  highest_equity_of_day — the intraday high-water mark, the harshest basis
   */
  basis: z.enum(['balance', 'equity', 'highest_equity_of_day']),
  include_open_pnl: z.boolean().default(true),
  threshold: thresholdSchema,
});

export const drawdownSchema = z.object({
  ...ruleBase,
  /**
   * static            — floor fixed at open, never moves (FTMO, FundedNext)
   * trailing_intraday — floor follows every new equity tick (Apex; harshest)
   * trailing_eod      — floor follows the end-of-day close (TopStep, Tradeify)
   */
  mode: z.enum(['static', 'trailing_intraday', 'trailing_eod']),
  /**
   * Where a trailing floor stops trailing. TopStep's stops permanently once it
   * reaches the starting balance, which is what makes a funded account safe to
   * hold — without it, a profitable account is never further from breach than
   * a new one.
   */
  lock: z.enum(['never', 'at_initial_balance', 'at_initial_plus']).default('never'),
  /** Only meaningful for lock = at_initial_plus. Absolute currency. */
  lock_buffer: z.number().min(0).optional(),
  basis: z.enum(['balance', 'equity']),
  threshold: thresholdSchema,
});

export const consistencySchema = z.object({
  ...ruleBase,
  /** Cap on any single day's share of total profit. 0.40 = 40%. */
  max_best_day_pct_of_profit: z.number().gt(0).max(1),
  /** Most firms test this only when a payout is requested. */
  evaluated_at: z.enum(['payout', 'continuous']).default('payout'),
  /** Below this total profit the rule is not meaningful; skip it. */
  min_profit_to_evaluate: z.number().min(0).default(0),
});

export const minTradingDaysSchema = z.object({
  ...ruleBase,
  min_days: z.number().int().positive(),
  /** The5ers requires 3 PROFITABLE days; most firms count any day traded. */
  count_basis: z.enum(['any_trade', 'profitable']).default('any_trade'),
});

export const inactivitySchema = z.object({
  ...ruleBase,
  max_idle_days: z.number().int().positive(),
});

export const positionLimitSchema = z.object({
  ...ruleBase,
  /**
   * by_account_size keys a contract/lot ceiling off the account's starting
   * balance; fixed applies one ceiling to every account.
   */
  mode: z.enum(['by_account_size', 'fixed']),
  fixed_limit: z.number().positive().optional(),
  /** Account starting balance (USD) -> max concurrent size. */
  limits_by_size: z.record(z.string(), z.number().positive()).optional(),
  /** Optional per-instrument-class overrides, e.g. { crypto: 0.5 }. */
  per_symbol_class: z.record(z.string(), z.number().positive()).optional(),
});

export const holdingWindowSchema = z.object({
  ...ruleBase,
  /** Positions still open at this session wall-clock time breach. */
  flat_by: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM'),
});

// ── Behavioural primitives ──────────────────────────────────────────────────

export const newsSchema = z.object({
  ...ruleBase,
  before_minutes: z.number().int().min(0),
  after_minutes: z.number().int().min(0),
  impact_levels: z.array(z.enum(['red', 'orange', 'yellow'])).min(1),
  /** Whether the blackout covers only instruments tied to the event currency. */
  applies_to: z.enum(['related_currency', 'all_instruments']).default('related_currency'),
});

export const hftSchema = z.object({
  ...ruleBase,
  /** Sliding windows: more than `max_trades` inside `window_seconds` breaches. */
  windows: z
    .array(
      z.object({
        window_seconds: z.number().int().positive(),
        max_trades: z.number().int().positive(),
      })
    )
    .min(1),
});

export const martingaleSchema = z.object({
  ...ruleBase,
  min_losing_streak: z.number().int().min(1),
  /** Size increase after a loss that counts as martingale. 1.5 = +50%. */
  volume_multiplier: z.number().gt(1),
});

export const gridSchema = z.object({
  ...ruleBase,
  time_window_seconds: z.number().int().positive(),
  lot_size_tolerance: z.number().gt(0).max(1),
  min_mirrored_trades: z.number().int().positive(),
  score_threshold: z.number().gt(0).max(1),
});

export const copyTradingSchema = z.object({
  ...ruleBase,
  lag_window_seconds: z.number().int().positive(),
  lot_size_tolerance: z.number().gt(0).max(1),
  min_copied_trades: z.number().int().positive(),
  score_threshold: z.number().gt(0).max(1),
});

// ── The pack ────────────────────────────────────────────────────────────────

/**
 * Every rule is optional: a firm that omits `news` simply has no news rule.
 * Omission and `enabled: false` mean the same thing, and both are distinct from
 * a permissive threshold.
 */
export const rulesSchema = z.object({
  daily_loss: dailyLossSchema.optional(),
  drawdown: drawdownSchema.optional(),
  consistency: consistencySchema.optional(),
  min_trading_days: minTradingDaysSchema.optional(),
  inactivity: inactivitySchema.optional(),
  position_limit: positionLimitSchema.optional(),
  overnight_holding: holdingWindowSchema.optional(),
  weekend_holding: holdingWindowSchema.optional(),
  news: newsSchema.optional(),
  hft: hftSchema.optional(),
  martingale: martingaleSchema.optional(),
  grid: gridSchema.optional(),
  copy_trading: copyTradingSchema.optional(),
});
export type Rules = z.infer<typeof rulesSchema>;
export type RuleId = keyof Rules;

export const RULE_IDS = [
  'daily_loss',
  'drawdown',
  'consistency',
  'min_trading_days',
  'inactivity',
  'position_limit',
  'overnight_holding',
  'weekend_holding',
  'news',
  'hft',
  'martingale',
  'grid',
  'copy_trading',
] as const satisfies readonly RuleId[];

export const RULE_PACK_SCHEMA_VERSION = 1;

export const rulePackSchema = z.object({
  schema_version: z.literal(RULE_PACK_SCHEMA_VERSION),
  /**
   * Asset class does NOT imply drawdown mode. Futures firms cluster on trailing
   * and forex firms on static, but The5ers runs a trailing 6% on forex — so the
   * two are independent parameters and this field is descriptive only.
   */
  asset_class: z.enum(['forex', 'futures']),
  name: z.string().trim().min(1).max(120),
  session: sessionSchema,
  rules: rulesSchema,
});
export type RulePack = z.infer<typeof rulePackSchema>;

export interface PackValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Semantic checks that a JSON schema cannot express. These are the
 * misconfigurations that would otherwise reach production looking valid.
 */
export function validateRulePack(pack: RulePack): PackValidationResult {
  const errors: string[] = [];
  const r = pack.rules;

  if (RULE_IDS.every((id) => !r[id]?.enabled)) {
    errors.push('A rule pack must enable at least one rule.');
  }

  if (r.drawdown?.enabled) {
    if (r.drawdown.lock === 'at_initial_plus' && r.drawdown.lock_buffer === undefined) {
      errors.push('drawdown.lock_buffer is required when lock is "at_initial_plus".');
    }
    if (r.drawdown.mode === 'static' && r.drawdown.lock !== 'never') {
      // A static floor never moves, so there is nothing for a lock to stop.
      // Silently ignoring this would hide a genuine misunderstanding.
      errors.push('drawdown.lock must be "never" when mode is "static" — a static floor does not trail.');
    }
  }

  if (r.position_limit?.enabled) {
    const { mode, fixed_limit, limits_by_size } = r.position_limit;
    if (mode === 'fixed' && fixed_limit === undefined) {
      errors.push('position_limit.fixed_limit is required when mode is "fixed".');
    }
    if (mode === 'by_account_size' && !limits_by_size) {
      errors.push('position_limit.limits_by_size is required when mode is "by_account_size".');
    }
    // The old futures engine silently fell back to `|| 10` contracts for any
    // account size outside a four-entry map, so an unlisted size was policed
    // against a number nobody chose. A gap is now an error at author time.
    if (mode === 'by_account_size' && limits_by_size && Object.keys(limits_by_size).length === 0) {
      errors.push('position_limit.limits_by_size must not be empty.');
    }
  }

  if (r.daily_loss?.enabled && r.drawdown?.enabled) {
    const dl = r.daily_loss.threshold;
    const dd = r.drawdown.threshold;
    if (dl.type === dd.type && dl.value > dd.value) {
      errors.push(
        'daily_loss threshold exceeds the drawdown threshold — the drawdown rule would always breach first, making the daily loss rule unreachable.'
      );
    }
  }

  if (r.consistency?.enabled && r.consistency.evaluated_at === 'continuous') {
    // Evaluated continuously, a consistency rule breaches on day one of any
    // profitable account, because one day is 100% of the profit so far.
    if (r.consistency.min_profit_to_evaluate <= 0) {
      errors.push(
        'consistency.min_profit_to_evaluate must be > 0 when evaluated_at is "continuous", or every account breaches on its first profitable day.'
      );
    }
  }

  for (const id of RULE_IDS) {
    const rule = r[id];
    if (rule?.enabled && rule.applies_to_phases.length === 0) {
      errors.push(`${id}.applies_to_phases must name at least one phase.`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Parse + semantically validate in one step. */
export function parseRulePack(input: unknown): { pack: RulePack; validation: PackValidationResult } {
  const pack = rulePackSchema.parse(input);
  return { pack, validation: validateRulePack(pack) };
}
