import { RULE_IDS, type RuleId, type RulePack, type Rules, type Threshold } from './schema';

/**
 * Plain-language change list between two packs.
 *
 * This exists because "v3 vs v2" as raw JSON is unreadable to the person who
 * has to decide whether to publish it, and a rule pack change is exactly the
 * kind of edit where the reader needs to see the two things this format
 * exists to prevent: a rule silently disappearing (`enabled: false` reads as
 * "removed", never as a lax threshold), and a percentage moving by an order of
 * magnitude without anyone noticing it was a fraction, not a percent.
 *
 * Pure and total: never throws, never touches the network or the store. Two
 * packs in, a list of sentences out.
 */

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface RulePackChange {
  ruleId: RuleId;
  kind: ChangeKind;
  /** The sentence a firm reads before publishing. */
  summary: string;
}

export interface RulePackDiff {
  nameChanged: boolean;
  assetClassChanged: boolean;
  sessionChanged: boolean;
  changes: RulePackChange[];
  /** True when nothing a trader-facing decision depends on has moved. */
  identical: boolean;
}

/** `0.05` -> `"5%"`. Rounds to at most two decimal places, no trailing zeros. */
function pct(fraction: number): string {
  return `${Number((fraction * 100).toFixed(2))}%`;
}

function thresholdLabel(t: Threshold): string {
  switch (t.type) {
    case 'fixed':
      return `$${t.value.toLocaleString()}`;
    case 'pct_of_initial':
      return `${pct(t.value)} of initial balance`;
    case 'pct_of_current':
      return `${pct(t.value)} of current balance`;
  }
}

function ruleLabel(id: RuleId): string {
  const labels: Record<RuleId, string> = {
    daily_loss: 'daily loss limit',
    drawdown: 'drawdown',
    consistency: 'consistency rule',
    min_trading_days: 'minimum trading days',
    inactivity: 'inactivity rule',
    position_limit: 'position limit',
    overnight_holding: 'overnight holding rule',
    weekend_holding: 'weekend holding rule',
    news: 'news blackout rule',
    hft: 'HFT detector',
    martingale: 'martingale detector',
    grid: 'grid detector',
    copy_trading: 'copy-trading detector',
  };
  return labels[id];
}

/** Field-by-field description of one rule's parameters, ordered by what a firm reads first. */
function describeRule(id: RuleId, rules: Rules): string[] {
  const r = rules[id];
  if (!r) return [];
  const lines: string[] = [];

  switch (id) {
    case 'daily_loss': {
      const rule = rules.daily_loss!;
      lines.push(`threshold ${thresholdLabel(rule.threshold)}`, `basis ${rule.basis}`);
      break;
    }
    case 'drawdown': {
      const rule = rules.drawdown!;
      lines.push(`threshold ${thresholdLabel(rule.threshold)}`, `mode ${rule.mode}`, `lock ${rule.lock}`);
      break;
    }
    case 'consistency': {
      const rule = rules.consistency!;
      lines.push(`max best day ${pct(rule.max_best_day_pct_of_profit)} of profit`, `evaluated at ${rule.evaluated_at}`);
      break;
    }
    case 'min_trading_days': {
      const rule = rules.min_trading_days!;
      lines.push(`${rule.min_days} day(s)`, `count basis ${rule.count_basis}`);
      break;
    }
    case 'inactivity': {
      const rule = rules.inactivity!;
      lines.push(`${rule.max_idle_days} idle day(s)`);
      break;
    }
    case 'position_limit': {
      const rule = rules.position_limit!;
      lines.push(`mode ${rule.mode}`);
      break;
    }
    case 'overnight_holding':
    case 'weekend_holding': {
      const rule = rules[id]!;
      lines.push(`flat by ${rule.flat_by}`);
      break;
    }
    case 'news': {
      const rule = rules.news!;
      lines.push(`${rule.before_minutes}min before / ${rule.after_minutes}min after`, `levels ${rule.impact_levels.join(', ')}`);
      break;
    }
    case 'hft': {
      const rule = rules.hft!;
      lines.push(`${rule.windows.length} window(s)`);
      break;
    }
    case 'martingale': {
      const rule = rules.martingale!;
      lines.push(`streak >= ${rule.min_losing_streak}`, `multiplier > ${rule.volume_multiplier}x`);
      break;
    }
    case 'grid': {
      const rule = rules.grid!;
      lines.push(`window ${rule.time_window_seconds}s`, `min mirrored ${rule.min_mirrored_trades}`);
      break;
    }
    case 'copy_trading': {
      const rule = rules.copy_trading!;
      lines.push(`lag window ${rule.lag_window_seconds}s`, `min copied ${rule.min_copied_trades}`);
      break;
    }
  }

  lines.push(`action ${r.action}`, `phases ${r.applies_to_phases.join(', ')}`);
  return lines;
}

/**
 * Compare parameter-by-parameter and describe what moved.
 *
 * Threshold and percentage changes get their own sentence — "5% -> 4%" — while
 * everything else that changed on the rule (action, phases, mode, ...) is
 * appended so a reader is never told "changed" without being told what.
 */
function describeChange(id: RuleId, before: Rules, after: Rules): string {
  const label = ruleLabel(id);
  const b = before[id]!;
  const a = after[id]!;
  const parts: string[] = [];

  // Threshold-bearing rules: lead with the number, because a 100x fraction/
  // percent mixup or a one-point tightening is the change most likely to be
  // the whole point of the edit.
  if ('threshold' in b && 'threshold' in a && JSON.stringify(b.threshold) !== JSON.stringify(a.threshold)) {
    parts.push(`threshold ${thresholdLabel(b.threshold)} -> ${thresholdLabel(a.threshold)}`);
  }
  if (
    id === 'consistency' &&
    'max_best_day_pct_of_profit' in b &&
    'max_best_day_pct_of_profit' in a &&
    b.max_best_day_pct_of_profit !== a.max_best_day_pct_of_profit
  ) {
    parts.push(`max best day ${pct(b.max_best_day_pct_of_profit)} -> ${pct(a.max_best_day_pct_of_profit)}`);
  }
  if (id === 'drawdown' && 'mode' in b && 'mode' in a && b.mode !== a.mode) {
    parts.push(`mode ${b.mode} -> ${a.mode}`);
  }
  if (id === 'drawdown' && 'lock' in b && 'lock' in a && b.lock !== a.lock) {
    parts.push(`lock ${b.lock} -> ${a.lock} (${a.lock === 'at_initial_balance' ? 'now locks at the starting balance' : 'lock behaviour changed'})`);
  }
  if (b.action !== a.action) {
    parts.push(`action ${b.action} -> ${a.action}`);
  }
  if (JSON.stringify(b.applies_to_phases) !== JSON.stringify(a.applies_to_phases)) {
    parts.push(`phases ${b.applies_to_phases.join('/')} -> ${a.applies_to_phases.join('/')}`);
  }

  if (parts.length === 0) {
    // Some other field on the rule moved (e.g. basis, count_basis, flat_by) —
    // fall back to a full re-description rather than claiming nothing changed.
    parts.push(describeRule(id, after).join(', '));
  }

  return `${label}: ${parts.join('; ')}`;
}

/** Compare two rule packs. Order and formatting are undefined implementation details; the sentences are the contract. */
export function diffRulePacks(before: RulePack, after: RulePack): RulePackDiff {
  const changes: RulePackChange[] = [];

  for (const id of RULE_IDS) {
    const b = before.rules[id];
    const a = after.rules[id];
    const bEnabled = Boolean(b?.enabled);
    const aEnabled = Boolean(a?.enabled);

    if (!bEnabled && aEnabled) {
      changes.push({
        ruleId: id,
        kind: 'added',
        summary: `${ruleLabel(id)} added (${describeRule(id, after.rules).join(', ')})`,
      });
      continue;
    }

    if (bEnabled && !aEnabled) {
      changes.push({
        ruleId: id,
        kind: 'removed',
        summary: `${ruleLabel(id)} removed`,
      });
      continue;
    }

    if (bEnabled && aEnabled) {
      const same = JSON.stringify(b) === JSON.stringify(a);
      if (!same) {
        changes.push({ ruleId: id, kind: 'changed', summary: describeChange(id, before.rules, after.rules) });
      }
    }
  }

  const nameChanged = before.name !== after.name;
  const assetClassChanged = before.asset_class !== after.asset_class;
  const sessionChanged = JSON.stringify(before.session) !== JSON.stringify(after.session);

  return {
    nameChanged,
    assetClassChanged,
    sessionChanged,
    changes,
    identical: changes.length === 0 && !assetClassChanged && !sessionChanged,
  };
}
