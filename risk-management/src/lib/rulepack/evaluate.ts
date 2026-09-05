import { RULE_IDS, type RulePack, type RuleId } from './schema';
import type { BreachDecision, EvaluationInput, EvaluationResult } from './types';
import { evaluateDailyLoss } from './primitives/daily-loss';
import { evaluateDrawdown } from './primitives/drawdown';
import {
  evaluateConsistency,
  evaluateHoldingWindow,
  evaluateInactivity,
  evaluateMinTradingDays,
  evaluatePositionLimit,
} from './primitives/account-rules';
import { evaluateHft, evaluateMartingale, evaluateNews } from './primitives/behavioural';

/**
 * The single entry point for breach evaluation.
 *
 * Pure: same pack + same inputs → same decisions, always. That is what makes
 * shadow mode free rather than a second implementation — replaying ninety days
 * of history is this same call with `enforce: false` at the persistence layer,
 * so a backtest can never disagree with production because they share no code
 * to drift between.
 *
 * Rules the engine could not evaluate are reported in `skipped` rather than
 * passing silently. A firm reading a backtest has to be able to tell "no
 * breach" from "not checked"; conflating them is how a platform assures a
 * customer of coverage it does not have.
 *
 * Cross-account rules (grid, copy_trading) are deliberately NOT evaluated here.
 * They compare one account against every other and are therefore a different
 * shape of computation — one that must be partitioned by tenant, since an
 * unpartitioned ring scan would surface one firm's trading patterns inside
 * another firm's alerts. They run in a separate per-tenant pass.
 */
export const CROSS_ACCOUNT_RULES: readonly RuleId[] = ['grid', 'copy_trading'];

export function evaluateRulePack(
  pack: RulePack,
  input: EvaluationInput,
  packVersion: string
): EvaluationResult {
  const decisions: BreachDecision[] = [];
  const skipped: EvaluationResult['skipped'] = [];

  const record = (ruleId: RuleId, result: { decisions: BreachDecision[]; skipped?: string }) => {
    decisions.push(...result.decisions);
    if (result.skipped) skipped.push({ ruleId, reason: result.skipped });
  };

  for (const ruleId of RULE_IDS) {
    const rule = pack.rules[ruleId];

    // Absent and disabled mean the same thing: the rule does not exist for this
    // firm. Lucid's funded accounts genuinely have no daily loss limit, so this
    // is a real configuration, not an omission to be defaulted.
    if (!rule || !rule.enabled) continue;

    // A rule can apply to only part of an account's life — Tradeify enforces
    // consistency during evaluation and drops it once funded.
    if (!rule.applies_to_phases.includes(input.account.phase)) continue;

    if (CROSS_ACCOUNT_RULES.includes(ruleId)) {
      skipped.push({
        ruleId,
        reason: 'cross-account rule: evaluated in the per-tenant network pass, not per account',
      });
      continue;
    }

    switch (ruleId) {
      case 'daily_loss':
        record(ruleId, evaluateDailyLoss(pack.rules.daily_loss!, pack.session, input, packVersion));
        break;
      case 'drawdown':
        record(ruleId, evaluateDrawdown(pack.rules.drawdown!, pack.session, input, packVersion));
        break;
      case 'consistency':
        record(ruleId, evaluateConsistency(pack.rules.consistency!, pack.session, input, packVersion));
        break;
      case 'min_trading_days':
        record(
          ruleId,
          evaluateMinTradingDays(pack.rules.min_trading_days!, pack.session, input, packVersion)
        );
        break;
      case 'inactivity':
        record(ruleId, evaluateInactivity(pack.rules.inactivity!, input, packVersion));
        break;
      case 'position_limit':
        record(ruleId, evaluatePositionLimit(pack.rules.position_limit!, input, packVersion));
        break;
      case 'overnight_holding':
      case 'weekend_holding':
        record(
          ruleId,
          evaluateHoldingWindow(ruleId, pack.rules[ruleId]!, pack.session, input, packVersion)
        );
        break;
      case 'news':
        record(ruleId, evaluateNews(pack.rules.news!, input, packVersion));
        break;
      case 'hft':
        record(ruleId, evaluateHft(pack.rules.hft!, input, packVersion));
        break;
      case 'martingale':
        record(ruleId, evaluateMartingale(pack.rules.martingale!, input, packVersion));
        break;
    }
  }

  return { accountId: input.account.id, decisions, skipped };
}

/**
 * Order decisions by how final they are. A terminated account is not also
 * "flagged for review", and a risk desk reading a queue needs the account-ending
 * decision first rather than buried under a dozen warnings.
 */
const ACTION_WEIGHT: Record<string, number> = {
  terminate: 0,
  pause_trading: 1,
  flag_for_review: 2,
  warn: 3,
};

export function sortDecisionsBySeverity(decisions: BreachDecision[]): BreachDecision[] {
  return [...decisions].sort((a, b) => {
    const byAction = (ACTION_WEIGHT[a.action] ?? 9) - (ACTION_WEIGHT[b.action] ?? 9);
    if (byAction !== 0) return byAction;
    return (b.exceededBy ?? 0) - (a.exceededBy ?? 0);
  });
}
