import { evaluateRulePack } from './evaluate';
import type { RulePack } from './schema';
import type { BreachAction, RuleId } from './schema';
import type { EvaluationInput } from './types';

/**
 * Impact preview: which currently-open accounts change status under a
 * candidate pack, before anyone publishes it.
 *
 * The reason this is its own module rather than a step inside `activate()`:
 * changing a drawdown from 5% to 4% is one keystroke, and the engine has no
 * way to know that keystroke is about to breach forty funded accounts unless
 * something replays every open account through both packs and diffs the
 * outcome. `activate()` already refuses a pack with no clean backtest, but a
 * backtest replays HISTORY — it does not tell a firm what happens to the
 * accounts open right now. This does.
 *
 * Pure, like the evaluator it wraps: same two packs and the same account
 * inputs always produce the same impact report, so a route handler owns all
 * I/O and this owns only the comparison.
 */

export interface AccountImpactInput {
  accountId: string;
  login: string;
  /** The same shape the evaluator and backtest already take. */
  input: EvaluationInput;
}

/** One rule's outcome for one account, under one pack. `null` action means no breach fired. */
interface RuleOutcome {
  ruleId: RuleId;
  action: BreachAction | null;
}

export interface AccountImpact {
  accountId: string;
  login: string;
  /** Rules that fire under the candidate pack but did not under the current one. */
  newBreaches: RuleOutcome[];
  /** Rules that fired under the current pack but do not under the candidate. */
  clearedBreaches: RuleOutcome[];
  /** Same rule fires under both, but the consequence changed (e.g. warn -> terminate). */
  actionChanges: Array<{ ruleId: RuleId; from: BreachAction; to: BreachAction }>;
}

export interface ImpactReport {
  accountsEvaluated: number;
  changed: AccountImpact[];
  unchangedCount: number;
  /** Accounts that would newly breach and TERMINATE — the worst-case subset, surfaced first. */
  newTerminations: number;
  summary: string;
}

function outcomesFor(pack: RulePack, input: EvaluationInput, packVersion: string): Map<RuleId, RuleOutcome> {
  const result = evaluateRulePack(pack, input, packVersion);
  const byRule = new Map<RuleId, RuleOutcome>();
  for (const decision of result.decisions) {
    // An account can breach the same rule more than once (e.g. daily_loss on
    // separate session days); the worst action wins because that is what the
    // account's status actually is at the end of the replay.
    const existing = byRule.get(decision.ruleId);
    if (!existing || severityRank(decision.action) > severityRank(existing.action)) {
      byRule.set(decision.ruleId, { ruleId: decision.ruleId, action: decision.action });
    }
  }
  return byRule;
}

const SEVERITY_ORDER: BreachAction[] = ['warn', 'flag_for_review', 'pause_trading', 'terminate'];
function severityRank(action: BreachAction | null): number {
  if (action === null) return -1;
  return SEVERITY_ORDER.indexOf(action);
}

/**
 * Compare a candidate pack against the currently active one (or `null`, for a
 * firm activating its first pack — every breach the candidate would produce
 * is then, correctly, a "new" one) across every open account.
 */
export function previewImpact(
  currentPack: RulePack | null,
  candidatePack: RulePack,
  accounts: AccountImpactInput[]
): ImpactReport {
  const changed: AccountImpact[] = [];
  let newTerminations = 0;

  for (const acct of accounts) {
    const currentOutcomes = currentPack ? outcomesFor(currentPack, acct.input, 'current') : new Map<RuleId, RuleOutcome>();
    const candidateOutcomes = outcomesFor(candidatePack, acct.input, 'candidate');

    const newBreaches: RuleOutcome[] = [];
    const actionChanges: AccountImpact['actionChanges'] = [];
    for (const [ruleId, outcome] of candidateOutcomes) {
      const before = currentOutcomes.get(ruleId);
      if (!before) {
        newBreaches.push(outcome);
        if (outcome.action === 'terminate') newTerminations += 1;
      } else if (before.action !== outcome.action) {
        actionChanges.push({ ruleId, from: before.action!, to: outcome.action! });
      }
    }

    const clearedBreaches: RuleOutcome[] = [];
    for (const [ruleId, outcome] of currentOutcomes) {
      if (!candidateOutcomes.has(ruleId)) clearedBreaches.push(outcome);
    }

    if (newBreaches.length > 0 || clearedBreaches.length > 0 || actionChanges.length > 0) {
      changed.push({ accountId: acct.accountId, login: acct.login, newBreaches, clearedBreaches, actionChanges });
    }
  }

  const unchangedCount = accounts.length - changed.length;

  return {
    accountsEvaluated: accounts.length,
    changed,
    unchangedCount,
    newTerminations,
    summary: summarise(changed.length, newTerminations, accounts.length),
  };
}

function summarise(changedCount: number, newTerminations: number, total: number): string {
  if (changedCount === 0) {
    return `No status change for any of the ${total} open account(s) evaluated.`;
  }
  const terminationClause =
    newTerminations > 0
      ? ` ${newTerminations} of those would be newly TERMINATED — review before publishing.`
      : '';
  return `${changedCount} of ${total} open account(s) would change status under this pack.${terminationClause}`;
}
