import { evaluateRulePack } from './evaluate';
import type { RulePack, RuleId } from './schema';
import type { BreachDecision, EvaluationInput } from './types';

/**
 * Shadow mode.
 *
 * A firm connects its platform, we replay its own recent history through its
 * candidate rule pack, and show it what the engine would have decided —
 * side by side with what its existing platform actually reported. That is a
 * self-serve proof of correctness, and it is what replaces the onboarding call:
 * the firm does not have to take our word for it, and we do not have to learn
 * their rulebook on a Zoom.
 *
 * This runs the SAME `evaluateRulePack` the live path runs. That is the whole
 * design: the evaluator is pure, so a backtest is the identical call with the
 * results written `enforced: false`. There is no second implementation that can
 * drift, so a backtest can never flatter production.
 *
 * The reconciliation is deliberately two-directional. Breaches we found that
 * the platform missed are interesting; breaches the PLATFORM reported that we
 * did not are the ones that matter, because each one is a place where the pack
 * and the firm's real rulebook disagree — a false negative in production would
 * be a breach that went unenforced.
 */

/** What the firm's existing platform says happened, for comparison. */
export interface ProviderReportedBreach {
  accountId: string;
  /** The platform's own label; mapped to our rule ids where possible. */
  type: string;
  at: string;
  amount?: number | null;
}

export interface ReconciliationEntry {
  accountId: string;
  ruleId: RuleId | string;
  sessionDay?: string;
  detail: string;
}

export interface BacktestReconciliation {
  /** Found by the engine, not reported by the platform. */
  engineOnly: ReconciliationEntry[];
  /** Reported by the platform, not found by the engine. The important list. */
  providerOnly: ReconciliationEntry[];
  /** Found by both. */
  agreed: ReconciliationEntry[];
}

export interface BacktestResult {
  accountsEvaluated: number;
  engineBreaches: number;
  providerBreaches: number;
  decisions: BreachDecision[];
  reconciliation: BacktestReconciliation;
  /** Rules that could not be evaluated anywhere in the run, deduplicated. */
  skipped: Array<{ ruleId: RuleId; reason: string }>;
  /**
   * Plain-language read on whether this pack is safe to activate. A firm should
   * not have to interpret three lists to answer "can I turn this on?".
   */
  verdict: {
    safeToActivate: boolean;
    summary: string;
  };
}

/**
 * Maps a platform's breach vocabulary onto rule pack ids. Deliberately
 * conservative: an unmapped platform label is left as-is and shows up in
 * `providerOnly` rather than being force-fitted onto a rule it may not mean.
 */
const PROVIDER_TYPE_TO_RULE: Record<string, RuleId> = {
  daily_loss: 'daily_loss',
  max_daily_loss: 'daily_loss',
  trailing_drawdown: 'drawdown',
  max_drawdown: 'drawdown',
  drawdown: 'drawdown',
  position_limit: 'position_limit',
  overleveraging: 'position_limit',
  consistency: 'consistency',
  hft: 'hft',
  martingale: 'martingale',
  news: 'news',
  copy: 'copy_trading',
  grid: 'grid',
};

export function normaliseProviderType(type: string): RuleId | string {
  return PROVIDER_TYPE_TO_RULE[type.toLowerCase()] ?? type;
}

export function runBacktest(
  pack: RulePack,
  packVersion: string,
  accountInputs: EvaluationInput[],
  providerReported: ProviderReportedBreach[] = []
): BacktestResult {
  const decisions: BreachDecision[] = [];
  const skippedSeen = new Map<string, { ruleId: RuleId; reason: string }>();

  for (const input of accountInputs) {
    const result = evaluateRulePack(pack, input, packVersion);
    decisions.push(...result.decisions);
    for (const s of result.skipped) {
      // One line per (rule, reason) rather than per account — a firm with 500
      // accounts missing snapshots needs one finding, not five hundred.
      skippedSeen.set(`${s.ruleId}:${s.reason}`, s);
    }
  }

  const reconciliation = reconcile(decisions, providerReported);

  return {
    accountsEvaluated: accountInputs.length,
    engineBreaches: decisions.length,
    providerBreaches: providerReported.length,
    decisions,
    reconciliation,
    skipped: [...skippedSeen.values()],
    verdict: verdictFor(reconciliation, [...skippedSeen.values()]),
  };
}

function reconcile(
  decisions: BreachDecision[],
  providerReported: ProviderReportedBreach[]
): BacktestReconciliation {
  // Match on account + rule rather than on exact timestamp: platforms stamp a
  // breach when their job noticed it, we stamp it when it occurred, and those
  // legitimately differ by minutes. Requiring an exact time match would report
  // every agreement as a disagreement.
  const engineIndex = new Map<string, BreachDecision[]>();
  for (const d of decisions) {
    const k = `${d.accountId}::${d.ruleId}`;
    const list = engineIndex.get(k);
    if (list) list.push(d);
    else engineIndex.set(k, [d]);
  }

  const providerIndex = new Map<string, ProviderReportedBreach[]>();
  for (const p of providerReported) {
    const k = `${p.accountId}::${normaliseProviderType(p.type)}`;
    const list = providerIndex.get(k);
    if (list) list.push(p);
    else providerIndex.set(k, [p]);
  }

  const agreed: ReconciliationEntry[] = [];
  const engineOnly: ReconciliationEntry[] = [];
  const providerOnly: ReconciliationEntry[] = [];

  for (const [k, ds] of engineIndex) {
    const [accountId, ruleId] = k.split('::');
    const entry: ReconciliationEntry = {
      accountId,
      ruleId,
      sessionDay: ds[0].evidence.sessionDay,
      detail: ds[0].evidence.observed,
    };
    if (providerIndex.has(k)) agreed.push(entry);
    else engineOnly.push(entry);
  }

  for (const [k, ps] of providerIndex) {
    if (engineIndex.has(k)) continue;
    const [accountId, ruleId] = k.split('::');
    providerOnly.push({
      accountId,
      ruleId,
      detail: `platform reported "${ps[0].type}" at ${ps[0].at}; the rule pack found no breach`,
    });
  }

  return { agreed, engineOnly, providerOnly };
}

/**
 * Whether a firm should activate this pack.
 *
 * `providerOnly` is the blocking signal. Each entry is a breach the firm's own
 * platform enforced and this pack would have let through — activating with
 * those outstanding means silently relaxing the firm's rules, which is the one
 * failure mode a risk platform must never have.
 *
 * `engineOnly` is not blocking. Finding breaches the incumbent missed is often
 * the reason a firm is switching, but it still warrants review: some will be
 * real, some will be a mis-set parameter.
 */
function verdictFor(
  reconciliation: BacktestReconciliation,
  skipped: Array<{ ruleId: RuleId; reason: string }>
): BacktestResult['verdict'] {
  const { agreed, engineOnly, providerOnly } = reconciliation;

  if (providerOnly.length > 0) {
    return {
      safeToActivate: false,
      summary:
        `${providerOnly.length} breach(es) your platform enforced would NOT have been caught by this pack. ` +
        `Activating as-is would relax your rules. Review these before going live.`,
    };
  }

  if (skipped.length > 0) {
    return {
      safeToActivate: false,
      summary:
        `${skipped.length} rule(s) could not be evaluated, so this run does not prove coverage. ` +
        `Resolve the missing inputs and re-run before activating.`,
    };
  }

  const extra =
    engineOnly.length > 0
      ? ` It also found ${engineOnly.length} breach(es) your platform did not report — review these, as some may be a mis-set parameter rather than a genuine catch.`
      : '';

  return {
    safeToActivate: true,
    summary:
      `This pack reproduced all ${agreed.length} breach(es) your platform reported, with none missed.${extra}`,
  };
}
