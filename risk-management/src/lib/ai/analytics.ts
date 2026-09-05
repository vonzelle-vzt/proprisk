import type { PlatformAccount, PlatformUser, PlatformTradeStats } from '@/types/platform';
import type { PlatformDeductions } from '@/types/payouts';
import type { RiskScoreResult, AnomalyFlag } from '@/types/ai';

const VIOLATION_TYPE_LABELS: Record<string, string> = {
  overleveraging: 'Overleveraging',
  hft: 'HFT',
  martingale: 'Martingale',
  news: 'News Trading',
  grid: 'Grid Trading',
  copy: 'Copy Trading',
  violations: 'Violations',
  overnight: 'Overnight',
};

export function getViolationLabel(type: string): string {
  return VIOLATION_TYPE_LABELS[type] || type;
}

export function computeRiskScore(params: {
  deductions: PlatformDeductions | null;
  account: PlatformAccount | null;
  user: PlatformUser | null;
  payoutAmount?: number;
}): RiskScoreResult {
  const { deductions, account, user, payoutAmount } = params;
  let score = 0;
  const reasons: string[] = [];

  // Deduction-based scoring
  if (deductions) {
    const totalDed = deductions.totalDeductions;
    if (totalDed > 500) {
      score += 35;
      reasons.push(`High deductions: $${totalDed.toFixed(2)}`);
    } else if (totalDed > 200) {
      score += 20;
      reasons.push(`Moderate deductions: $${totalDed.toFixed(2)}`);
    } else if (totalDed > 50) {
      score += 10;
      reasons.push(`Minor deductions: $${totalDed.toFixed(2)}`);
    }

    // Multiple violation types
    const violationTypeCount = Object.keys(deductions.breakdownByType).filter(
      (k) => deductions.breakdownByType[k] > 0
    ).length;
    if (violationTypeCount >= 3) {
      score += 15;
      reasons.push(`${violationTypeCount} different violation types`);
    } else if (violationTypeCount >= 2) {
      score += 5;
    }

    // Deduction as % of PnL
    if (deductions.percentOfTotalPL > 20) {
      score += 10;
      reasons.push(`Deductions are ${deductions.percentOfTotalPL >= 100 ? '>100' : deductions.percentOfTotalPL.toFixed(1)}% of total PnL`);
    }
  }

  // Blacklist check
  if (user?.isBlackListed === 1) {
    score += 30;
    reasons.push('User is blacklisted');
  }

  // KYC check
  if (user && user.isKycVerified !== 1) {
    score += 15;
    reasons.push(`KYC not verified (status: ${user.kycStatus})`);
  }

  // Banned activity flags
  if (account) {
    const bannedViolations: string[] = [];
    if (account.banNewsTrading === 1 && deductions?.breakdownByType?.news) {
      bannedViolations.push('News');
    }
    if (account.banHFT === 1 && deductions?.breakdownByType?.hft) {
      bannedViolations.push('HFT');
    }
    if (account.banMTGL === 1 && deductions?.breakdownByType?.martingale) {
      bannedViolations.push('Martingale');
    }
    if (bannedViolations.length > 0) {
      score += 10;
      reasons.push(`Banned activity detected: ${bannedViolations.join(', ')}`);
    }
  }

  // Payout vs balance ratio
  if (payoutAmount && account?.startingBalance) {
    const payoutRatio = payoutAmount / account.startingBalance;
    if (payoutRatio > 0.05) {
      score += 5;
      reasons.push(`Payout is ${(payoutRatio * 100).toFixed(1)}% of starting balance`);
    }
  }

  // Cap at 100
  score = Math.min(score, 100);

  const level: RiskScoreResult['level'] =
    score >= 70 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';

  return { score, level, reasons };
}

export function detectAnomalies(params: {
  accountId: string;
  deductions: PlatformDeductions | null;
  account: PlatformAccount | null;
  user: PlatformUser | null;
  payoutAmount?: number;
  payoutRequested?: string;
}): AnomalyFlag[] {
  const { accountId, deductions, account, user, payoutAmount, payoutRequested } = params;
  const flags: AnomalyFlag[] = [];

  // Blacklisted user with pending payout
  if (user?.isBlackListed === 1 && payoutAmount && payoutAmount > 0) {
    flags.push({
      type: 'blacklisted_payout',
      severity: 'critical',
      description: `Blacklisted user has a pending payout of $${payoutAmount.toFixed(2)}`,
      accountId,
    });
  }

  // Deductions > 20% of PnL
  if (deductions && deductions.percentOfTotalPL > 20) {
    flags.push({
      type: 'high_deduction_ratio',
      severity: 'warning',
      description: `Deductions are ${deductions.percentOfTotalPL >= 100 ? '>100' : deductions.percentOfTotalPL.toFixed(1)}% of total PnL`,
      accountId,
    });
  }

  // More than 3 violation types
  if (deductions) {
    const violationTypeCount = Object.keys(deductions.breakdownByType).filter(
      (k) => deductions.breakdownByType[k] > 0
    ).length;
    if (violationTypeCount > 3) {
      flags.push({
        type: 'multi_violation',
        severity: 'warning',
        description: `Account has ${violationTypeCount} different violation types`,
        accountId,
      });
    }
  }

  // Payout requested very early after account creation
  if (payoutRequested && account?.addedUTC) {
    const requestedDate = new Date(payoutRequested);
    const createdDate = new Date(account.addedUTC);
    const daysDiff = (requestedDate.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysDiff < 1 && daysDiff >= 0) {
      flags.push({
        type: 'early_payout',
        severity: 'critical',
        description: `Payout requested within 24 hours of account creation`,
        accountId,
      });
    }
  }

  return flags;
}

export function analyzeTradeProfile(stats: PlatformTradeStats | null): string | null {
  if (!stats) return null;

  const lines: string[] = [];
  const { totals, winRates, ratios, daily, time, bySymbol, drawdowns } = stats;

  // Win rate assessment
  if (winRates.all > 0.7) {
    lines.push(`Unusually high win rate (${(winRates.all * 100).toFixed(1)}%) — may indicate strategy manipulation`);
  } else if (winRates.all < 0.3) {
    lines.push(`Very low win rate (${(winRates.all * 100).toFixed(1)}%) — possible gambler behavior`);
  }

  // Hold time assessment
  if (time.avgHoldAll_human) {
    lines.push(`Average hold time: ${time.avgHoldAll_human}`);
  }

  // Symbol concentration
  if (bySymbol.pnl.length > 0) {
    const topSymbol = bySymbol.pnl[0];
    const totalPnl = bySymbol.pnl.reduce((sum, s) => sum + Math.abs(s.pnl), 0);
    if (totalPnl > 0) {
      const concentration = Math.abs(topSymbol.pnl) / totalPnl;
      if (concentration > 0.8) {
        lines.push(`Highly concentrated on ${topSymbol.symbol} (${(concentration * 100).toFixed(0)}% of PnL)`);
      }
    }
  }

  // Drawdown assessment
  if (drawdowns.maxDrawdown > 0) {
    lines.push(`Max drawdown: $${drawdowns.maxDrawdown.toFixed(2)}`);
  }

  // Profit factor
  if (ratios.profitFactor > 0) {
    lines.push(`Profit factor: ${ratios.profitFactor.toFixed(2)}`);
  }

  // Sharpe ratio
  if (ratios.sharpeRatio !== 0) {
    const quality = ratios.sharpeRatio > 2 ? 'excellent' : ratios.sharpeRatio > 1 ? 'good' : ratios.sharpeRatio > 0 ? 'moderate' : 'poor';
    lines.push(`Sharpe ratio: ${ratios.sharpeRatio.toFixed(2)} (${quality})`);
  }

  // Consecutive losing days
  if (daily.maxConsecutiveLosingDays > 5) {
    lines.push(`Had ${daily.maxConsecutiveLosingDays} consecutive losing days — possible tilt behavior`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}
