import type {
  SeverityAssessment,
  SeverityFactor,
  RecommendedAction,
  EscalationLevel,
  AccountViolationHistory,
} from '@/types/enforcement';

const VIOLATION_BASE_POINTS: Record<string, number> = {
  copy: 25,
  martingale: 20,
  grid: 20,
  profit_cap: 15,
  '2_percent_cap': 15,
  overleveraging: 15,
  hft: 10,
  news: 10,
};

function scoreToEscalation(score: number): EscalationLevel {
  if (score >= 76) return 'critical';
  if (score >= 51) return 'urgent';
  if (score >= 26) return 'elevated';
  return 'normal';
}

/**
 * Compute repeat multiplier based on how many prior violations of the same
 * type occurred within the last 30 days.
 */
export function computeRepeatMultiplier(priorCount30d: number): number {
  if (priorCount30d <= 0) return 1.0;
  if (priorCount30d === 1) return 1.5;
  if (priorCount30d === 2) return 2.0;
  return 2.5; // 3+
}

interface SeverityParams {
  violationType: string;
  deductionAmount: number;
  history: AccountViolationHistory[];
  accountAge?: number; // days
  hasPendingPayout?: boolean;
  pendingPayoutAmount?: number;
  hasBanForType?: boolean;
}

export function assessSeverity(params: SeverityParams): SeverityAssessment {
  const {
    violationType,
    deductionAmount,
    history,
    accountAge,
    hasPendingPayout,
    pendingPayoutAmount,
    hasBanForType,
  } = params;

  const factors: SeverityFactor[] = [];
  let score = 0;

  // 1. Base violation type points
  const basePoints = VIOLATION_BASE_POINTS[violationType] ?? 10;
  score += basePoints;
  factors.push({
    name: 'violation_type',
    points: basePoints,
    description: `Base score for ${violationType} violation`,
  });

  // 2. Deduction amount
  let amountPoints = 0;
  if (deductionAmount > 500) amountPoints = 20;
  else if (deductionAmount > 200) amountPoints = 15;
  else if (deductionAmount > 100) amountPoints = 10;
  else if (deductionAmount > 50) amountPoints = 5;
  if (amountPoints > 0) {
    score += amountPoints;
    factors.push({
      name: 'deduction_amount',
      points: amountPoints,
      description: `Deduction amount $${deductionAmount.toFixed(2)}`,
    });
  }

  // 3. Repeat same type in history
  const sameType = history.find((h) => h.violation_type === violationType);
  const priorCount = sameType?.total_count ?? 0;
  let repeatPoints = 0;
  if (priorCount >= 6) repeatPoints = 25;
  else if (priorCount >= 4) repeatPoints = 15;
  else if (priorCount >= 2) repeatPoints = 10;
  else if (priorCount >= 1) repeatPoints = 5;
  if (repeatPoints > 0) {
    score += repeatPoints;
    factors.push({
      name: 'repeat_offender',
      points: repeatPoints,
      description: `${priorCount} prior ${violationType} violation(s)`,
    });
  }

  // 4. Multiple distinct violation types in last 30 days
  const distinctTypes30d = history.filter((h) => h.count_last_30d > 0).length;
  if (distinctTypes30d >= 3) {
    score += 10;
    factors.push({
      name: 'multi_type',
      points: 10,
      description: `${distinctTypes30d} distinct violation types in last 30 days`,
    });
  }

  // 5. New account
  if (accountAge !== undefined && accountAge < 7) {
    score += 10;
    factors.push({
      name: 'new_account',
      points: 10,
      description: `Account is only ${accountAge} day(s) old`,
    });
  }

  // 6. Pending payout
  if (hasPendingPayout) {
    if (pendingPayoutAmount && pendingPayoutAmount > 1000) {
      score += 10;
      factors.push({
        name: 'large_pending_payout',
        points: 10,
        description: `Pending payout of $${pendingPayoutAmount.toFixed(2)}`,
      });
    } else {
      score += 5;
      factors.push({
        name: 'pending_payout',
        points: 5,
        description: 'Has a pending payout',
      });
    }
  }

  // 7. Banned activity match
  if (hasBanForType) {
    score += 15;
    factors.push({
      name: 'banned_activity',
      points: 15,
      description: `Account has ban flag for ${violationType}`,
    });
  }

  // Cap at 100
  score = Math.min(score, 100);
  const escalation_level = scoreToEscalation(score);

  // Compute repeat multiplier for deduction scaling
  const prior30d = sameType?.count_last_30d ?? 0;
  const repeatMultiplier = computeRepeatMultiplier(prior30d);

  // Build recommended actions based on severity
  const recommended_actions: RecommendedAction[] = [];

  // Always recommend deduction
  if (deductionAmount > 0) {
    recommended_actions.push({
      action_type: 'deduction',
      amount: Math.round(deductionAmount * repeatMultiplier * 100) / 100,
      reason: `${violationType} deduction ($${deductionAmount.toFixed(2)} x ${repeatMultiplier}x multiplier)`,
      priority: 1,
    });
  }

  // Payout hold if severity >= 50 and has pending payout
  if (score >= 50 && hasPendingPayout) {
    recommended_actions.push({
      action_type: 'payout_hold',
      amount: pendingPayoutAmount ?? 0,
      reason: `Hold payout pending review — severity score ${score}`,
      priority: 2,
    });
  }

  // Escalation if severity >= 70
  if (score >= 70) {
    recommended_actions.push({
      action_type: 'escalation',
      amount: 0,
      reason: `Critical severity (${score}) — requires senior review`,
      priority: 3,
    });
  }

  // Account restriction if 3+ repeat offenses
  if (priorCount >= 3) {
    recommended_actions.push({
      action_type: 'account_restriction',
      amount: 0,
      reason: `${priorCount} prior ${violationType} violations — recommend restriction`,
      priority: 4,
    });
  }

  return { score, escalation_level, factors, recommended_actions };
}
