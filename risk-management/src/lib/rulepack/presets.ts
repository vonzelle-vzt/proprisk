import type { RulePack } from './schema';
import { RULE_PACK_SCHEMA_VERSION } from './schema';

/**
 * Starting points modelled on how the market's best-known firms actually
 * define breaches.
 *
 * These exist because firms overwhelmingly copy one another's risk model and
 * adjust a number or two. A firm that recognises its own shape in one of these
 * can be live in minutes instead of on an onboarding call, which is the entire
 * self-serve thesis.
 *
 * They are STARTING POINTS, not published rulebooks. Firms change terms without
 * notice, and a stale preset applied as-is would breach accounts against rules
 * nobody agreed to — worse than having no preset at all. Every preset is
 * therefore created as a `draft`, must be reviewed against the firm's own
 * current rulebook, and must pass a shadow-mode backtest before it can enforce.
 *
 * The names describe a RULE SHAPE, not an affiliation: "Apex-style" means
 * intraday-trailing drawdown locking at the initial balance, and any firm using
 * that shape should start here.
 */

/** CME futures: the session opens 17:00 ET the previous calendar day. */
const CME_SESSION = {
  timezone: 'America/New_York',
  day_start: '17:00',
  week_start: 'sunday' as const,
};

/** Forex: firms overwhelmingly reset on the broker's server midnight. */
const FX_SESSION = {
  timezone: 'Europe/Prague',
  day_start: '00:00',
  week_start: 'sunday' as const,
};

const ALL_PHASES = ['challenge', 'verification', 'funded'] as const;

/**
 * Provenance. A preset is a claim about somebody else's published rules, and
 * firms revise those without telling anyone. A stale preset applied as-is
 * breaches accounts against rules nobody agreed to — strictly worse than having
 * no preset, because it carries false authority.
 *
 * So staleness is data the product can act on rather than a caveat in a
 * document nobody reads: a preset that has never been checked against the
 * firm's own rulebook, or was checked too long ago, says so wherever it appears.
 */
export type PresetConfidence = 'verified' | 'stale' | 'unverified';

/** Published rules drift. Past this, a check is due regardless. */
export const PRESET_RECHECK_DAYS = 90;

export interface PresetProvenance {
  /** Where the numbers came from. A URL a human can open and compare. */
  source: string | null;
  /**
   * When a human last compared this preset to that source, ISO date.
   * `null` means NOBODY HAS. Every preset shipped so far is null: they were
   * derived from secondary research, not from the firms' published terms.
   */
  verifiedAt: string | null;
  /** Who checked, so a disputed preset has someone to ask. */
  verifiedBy?: string;
}

export interface PresetMeta {
  id: string;
  label: string;
  description: string;
  assetClass: 'forex' | 'futures';
  provenance: PresetProvenance;
  pack: RulePack;
}

export function presetConfidence(
  preset: PresetMeta,
  now: Date = new Date()
): PresetConfidence {
  if (!preset.provenance.verifiedAt) return 'unverified';

  const ageDays = (now.getTime() - Date.parse(preset.provenance.verifiedAt)) / 86_400_000;
  return ageDays > PRESET_RECHECK_DAYS ? 'stale' : 'verified';
}

/**
 * What to tell a firm about to build on this preset. Written for the customer,
 * not for a log: they are the ones who will be enforcing it.
 */
export function presetConfidenceNotice(preset: PresetMeta, now?: Date): string | null {
  switch (presetConfidence(preset, now)) {
    case 'unverified':
      return (
        `This preset models ${preset.label.replace(/-style$/, '')}’s published rules as we understand ` +
        `them, but has not been checked against their current rulebook. Confirm every threshold ` +
        `against your own rules before activating — and the shadow-mode backtest will show you ` +
        `where it disagrees with your platform.`
      );
    case 'stale':
      return (
        `This preset was last checked on ${preset.provenance.verifiedAt}. Firms revise their rules ` +
        `without notice, so confirm the thresholds still match before activating.`
      );
    case 'verified':
      return null;
  }
}

/**
 * Apex-style — intraday trailing.
 *
 * The floor moves on every new equity high, tick by tick, and stops only once
 * it reaches the account's starting balance. The harshest model in common use:
 * an unrealised spike you never bank still ratchets the floor up permanently.
 */
const apexStyle: RulePack = {
  schema_version: RULE_PACK_SCHEMA_VERSION,
  asset_class: 'futures',
  name: 'Apex-style (intraday trailing drawdown)',
  session: CME_SESSION,
  rules: {
    drawdown: {
      enabled: true,
      mode: 'trailing_intraday',
      lock: 'at_initial_balance',
      basis: 'equity',
      threshold: { type: 'pct_of_initial', value: 0.05 },
      applies_to_phases: [...ALL_PHASES],
      action: 'terminate',
    },
    position_limit: {
      enabled: true,
      mode: 'by_account_size',
      limits_by_size: { '25000': 4, '50000': 10, '100000': 14, '150000': 17, '250000': 27 },
      applies_to_phases: [...ALL_PHASES],
      action: 'flag_for_review',
    },
    overnight_holding: {
      enabled: true,
      flat_by: '16:59',
      applies_to_phases: [...ALL_PHASES],
      action: 'flag_for_review',
    },
  },
};

/**
 * TopStep-style — end-of-day trailing.
 *
 * The floor follows the day's CLOSE, so an intraday round-trip costs nothing,
 * and it locks permanently at the starting balance. Materially more forgiving
 * than the intraday model despite the identical headline percentage.
 */
const topstepStyle: RulePack = {
  schema_version: RULE_PACK_SCHEMA_VERSION,
  asset_class: 'futures',
  name: 'TopStep-style (end-of-day trailing + consistency)',
  session: CME_SESSION,
  rules: {
    drawdown: {
      enabled: true,
      mode: 'trailing_eod',
      lock: 'at_initial_balance',
      basis: 'equity',
      threshold: { type: 'pct_of_initial', value: 0.04 },
      applies_to_phases: [...ALL_PHASES],
      action: 'terminate',
    },
    daily_loss: {
      enabled: true,
      basis: 'equity',
      include_open_pnl: true,
      threshold: { type: 'pct_of_initial', value: 0.02 },
      applies_to_phases: [...ALL_PHASES],
      action: 'pause_trading',
    },
    // Enforced during payout cycles, so it is scoped to funded accounts.
    consistency: {
      enabled: true,
      max_best_day_pct_of_profit: 0.5,
      evaluated_at: 'payout',
      min_profit_to_evaluate: 0,
      applies_to_phases: ['funded'],
      action: 'flag_for_review',
    },
    min_trading_days: {
      enabled: true,
      min_days: 2,
      count_basis: 'profitable',
      applies_to_phases: ['challenge', 'verification'],
      action: 'flag_for_review',
    },
  },
};

/**
 * Tradeify-style — end-of-day trailing, consistency in evaluation only.
 *
 * The instructive part is `applies_to_phases`: the 40% consistency rule governs
 * the evaluation and is DROPPED once funded. A rule that were unconditionally
 * on would breach funded accounts against a rule they are not subject to.
 */
const tradeifyStyle: RulePack = {
  schema_version: RULE_PACK_SCHEMA_VERSION,
  asset_class: 'futures',
  name: 'Tradeify-style (EOD drawdown, consistency in evaluation only)',
  session: CME_SESSION,
  rules: {
    drawdown: {
      enabled: true,
      mode: 'trailing_eod',
      lock: 'at_initial_balance',
      basis: 'equity',
      threshold: { type: 'pct_of_initial', value: 0.04 },
      applies_to_phases: [...ALL_PHASES],
      action: 'terminate',
    },
    daily_loss: {
      enabled: true,
      basis: 'equity',
      include_open_pnl: true,
      threshold: { type: 'pct_of_initial', value: 0.03 },
      applies_to_phases: [...ALL_PHASES],
      action: 'pause_trading',
    },
    consistency: {
      enabled: true,
      max_best_day_pct_of_profit: 0.4,
      evaluated_at: 'payout',
      min_profit_to_evaluate: 0,
      applies_to_phases: ['challenge', 'verification'],
      action: 'flag_for_review',
    },
  },
};

/**
 * Lucid-style — the preset that proves `enabled: false` has to mean something.
 *
 * The funded product has NO daily loss limit and NO consistency rule. Those
 * rules are simply absent here. Modelling them as very large thresholds would
 * be wrong in a way that shows up as phantom breach records.
 */
const lucidStyle: RulePack = {
  schema_version: RULE_PACK_SCHEMA_VERSION,
  asset_class: 'futures',
  name: 'Lucid-style (EOD drawdown, no daily loss, no consistency)',
  session: CME_SESSION,
  rules: {
    drawdown: {
      enabled: true,
      mode: 'trailing_eod',
      lock: 'at_initial_balance',
      basis: 'equity',
      threshold: { type: 'pct_of_initial', value: 0.05 },
      applies_to_phases: [...ALL_PHASES],
      action: 'terminate',
    },
    // No daily_loss. No consistency. Deliberate — this is the product.
  },
};

/**
 * FTMO-style — static drawdown, balance-based.
 *
 * The floor is set at open and never moves: on a $100k account at 10% it is
 * $90,000 whether the account grows to $120k or sits flat.
 */
const ftmoStyle: RulePack = {
  schema_version: RULE_PACK_SCHEMA_VERSION,
  asset_class: 'forex',
  name: 'FTMO-style (static 10% drawdown, 5% daily)',
  session: FX_SESSION,
  rules: {
    drawdown: {
      enabled: true,
      mode: 'static',
      lock: 'never',
      basis: 'balance',
      threshold: { type: 'pct_of_initial', value: 0.1 },
      applies_to_phases: [...ALL_PHASES],
      action: 'terminate',
    },
    daily_loss: {
      enabled: true,
      basis: 'balance',
      include_open_pnl: true,
      threshold: { type: 'pct_of_initial', value: 0.05 },
      applies_to_phases: [...ALL_PHASES],
      action: 'terminate',
    },
  },
};

/** FundedNext-style — the same static shape as FTMO at the headline numbers. */
const fundednextStyle: RulePack = {
  schema_version: RULE_PACK_SCHEMA_VERSION,
  asset_class: 'forex',
  name: 'FundedNext-style (static 10% drawdown, 5% daily)',
  session: FX_SESSION,
  rules: {
    drawdown: {
      enabled: true,
      mode: 'static',
      lock: 'never',
      basis: 'balance',
      threshold: { type: 'pct_of_initial', value: 0.1 },
      applies_to_phases: [...ALL_PHASES],
      action: 'terminate',
    },
    daily_loss: {
      enabled: true,
      basis: 'balance',
      include_open_pnl: true,
      threshold: { type: 'pct_of_initial', value: 0.05 },
      applies_to_phases: [...ALL_PHASES],
      action: 'terminate',
    },
  },
};

/**
 * The5ers-style — trailing drawdown on FOREX.
 *
 * This preset exists to break the tidy assumption that futures firms trail and
 * forex firms are static. The5ers' Hyper Growth trails the account high on a
 * forex product, which is why `asset_class` is descriptive only and never
 * implies a drawdown mode.
 *
 * It is also the clearest case for `action` being its own parameter: the daily
 * loss here TERMINATES the account, where the same rule at other firms merely
 * pauses trading for the day.
 */
const the5ersStyle: RulePack = {
  schema_version: RULE_PACK_SCHEMA_VERSION,
  asset_class: 'forex',
  name: 'The5ers-style (trailing forex drawdown, terminating daily loss)',
  session: FX_SESSION,
  rules: {
    drawdown: {
      enabled: true,
      mode: 'trailing_eod',
      lock: 'never',
      basis: 'equity',
      threshold: { type: 'pct_of_initial', value: 0.06 },
      applies_to_phases: [...ALL_PHASES],
      action: 'terminate',
    },
    daily_loss: {
      enabled: true,
      basis: 'equity',
      include_open_pnl: true,
      threshold: { type: 'pct_of_initial', value: 0.03 },
      applies_to_phases: [...ALL_PHASES],
      action: 'terminate',
    },
    min_trading_days: {
      enabled: true,
      min_days: 3,
      count_basis: 'profitable',
      applies_to_phases: ['challenge', 'verification'],
      action: 'flag_for_review',
    },
  },
};

export const RULE_PACK_PRESETS: PresetMeta[] = [
  {
    id: 'apex-style',
    label: 'Apex-style',
    description:
      'Intraday trailing drawdown that locks at the starting balance. The strictest common futures model — an unrealised spike permanently raises the floor.',
    assetClass: 'futures',
    provenance: { source: 'https://apextraderfunding.com/rules', verifiedAt: null },
    pack: apexStyle,
  },
  {
    id: 'topstep-style',
    label: 'TopStep-style',
    description:
      'End-of-day trailing drawdown locking at the starting balance, a daily loss limit, and a consistency rule on funded accounts only.',
    assetClass: 'futures',
    provenance: { source: 'https://www.topstep.com/blog/prop-firm-drawdown-rules', verifiedAt: null },
    pack: topstepStyle,
  },
  {
    id: 'tradeify-style',
    label: 'Tradeify-style',
    description:
      'End-of-day trailing drawdown with a 40% consistency rule that applies during evaluation and is dropped once funded.',
    assetClass: 'futures',
    provenance: { source: 'https://tradeify.co/', verifiedAt: null },
    pack: tradeifyStyle,
  },
  {
    id: 'lucid-style',
    label: 'Lucid-style',
    description:
      'End-of-day trailing drawdown only — no daily loss limit and no consistency rule on funded accounts.',
    assetClass: 'futures',
    provenance: { source: 'https://lucidtrading.com/', verifiedAt: null },
    pack: lucidStyle,
  },
  {
    id: 'ftmo-style',
    label: 'FTMO-style',
    description:
      'Static 10% maximum drawdown measured on balance, plus a 5% daily loss limit. The floor never moves.',
    assetClass: 'forex',
    provenance: { source: 'https://ftmo.com/en/trading-objectives/', verifiedAt: null },
    pack: ftmoStyle,
  },
  {
    id: 'fundednext-style',
    label: 'FundedNext-style',
    description: 'Static 10% maximum drawdown with a 5% daily loss limit.',
    assetClass: 'forex',
    provenance: { source: 'https://fundednext.com/', verifiedAt: null },
    pack: fundednextStyle,
  },
  {
    id: 'the5ers-style',
    label: 'The5ers-style',
    description:
      'Trailing 6% drawdown on a forex product, with a 3% daily loss that terminates the account rather than pausing it, and a minimum of 3 profitable days.',
    assetClass: 'forex',
    provenance: { source: 'https://the5ers.com/', verifiedAt: null },
    pack: the5ersStyle,
  },
];

export function presetById(id: string): PresetMeta | undefined {
  return RULE_PACK_PRESETS.find((p) => p.id === id);
}
