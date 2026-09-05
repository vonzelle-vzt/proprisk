import { tenantDb } from '@/lib/db/tenant-scoped';
import { logError } from '@/lib/logging/logger';
import { FRAUD_HUNTER_CONFIG } from '@/config/fraud-hunter';
import type { FraudDetectorResult, FraudFinding } from '@/types/fraud';

interface AccountSnapshot {
  platform_account_id: string;
  login: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  country: string | null;
  plan: string | null;
  starting_balance: number | null;
  balance: number | null;
  total_pnl: number | null;
  traded_days: number | null;
  num_approved_payouts: number | null;
  is_blacklisted: boolean;
  deductions_total: number | null;
  updated_at: string;
  created_at: string;
}

function generateDedupeKey(email: string, accountIds: string[]): string {
  const sorted = [...accountIds].sort();
  const today = new Date().toISOString().slice(0, 10);
  return `account_churning:${sorted.join(':')}:${today}`;
}

function deriveSeverity(
  totalAccounts: number,
  failedRatio: number,
  maxAccounts: number
): 'low' | 'medium' | 'high' | 'critical' {
  if (totalAccounts >= maxAccounts * 2 && failedRatio > 0.7) return 'critical';
  if (totalAccounts >= maxAccounts * 1.5 || failedRatio > 0.6) return 'high';
  if (totalAccounts >= maxAccounts) return 'medium';
  return 'low';
}

function computeConfidence(
  totalAccounts: number,
  failedAccounts: number,
  maxAccounts: number,
  failedThreshold: number
): number {
  let score = 0;

  // Excess accounts above threshold
  const excessRatio = totalAccounts / maxAccounts;
  if (excessRatio >= 2) score += 40;
  else if (excessRatio >= 1.5) score += 30;
  else if (excessRatio >= 1) score += 20;

  // Failed account ratio
  const failedRatio = totalAccounts > 0 ? failedAccounts / totalAccounts : 0;
  if (failedAccounts >= failedThreshold) {
    score += 30;
  }
  if (failedRatio > 0.5) {
    score += Math.round(failedRatio * 30);
  }

  return Math.min(Math.max(score, 0), 100);
}

/**
 * Detect account churning — users creating many accounts, especially with high failure rates.
 *
 * Groups accounts by email to find users with excessive account creation.
 * Flags users exceeding the max_accounts_per_user threshold and those with
 * high ratios of failed/inactive accounts.
 */
export async function detectAccountChurning(tenantId: string): Promise<FraudDetectorResult> {
  const findings: FraudFinding[] = [];
  const config = FRAUD_HUNTER_CONFIG.account_churning;

  try {
    const db = tenantDb(tenantId, 'fraud-hunter account-churning detector');

    // Calculate lookback cutoff
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - config.lookback_days);

    const { data: snapshots, error } = await db
      .select(
        'account_snapshots',
        'platform_account_id, login, email, first_name, last_name, country, plan, ' +
        'starting_balance, balance, total_pnl, traded_days, num_approved_payouts, ' +
        'is_blacklisted, deductions_total, updated_at, created_at'
      )
      .gte('created_at', cutoff.toISOString())
      .order('created_at', { ascending: true })
      .limit(2000);

    if (error) {
      logError('Account churning detector: failed to fetch snapshots', error, {
        route: 'lib/fraud-hunter/detectors/account-churning',
        category: 'database',
        tenant_id: tenantId,
      });
      return { fraud_type: 'account_churning', findings: [] };
    }

    if (!snapshots || snapshots.length === 0) {
      return { fraud_type: 'account_churning', findings: [] };
    }

    const accounts = snapshots as unknown as AccountSnapshot[];

    // Group by email
    const byEmail = new Map<string, AccountSnapshot[]>();
    for (const acct of accounts) {
      if (!acct.email) continue;
      const email = acct.email.toLowerCase();
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email)!.push(acct);
    }

    for (const [email, userAccounts] of byEmail) {
      if (userAccounts.length < config.max_accounts_per_user) continue;

      // Count "failed" accounts — heuristic: accounts with 0 traded days,
      // negative PnL, or very low balance relative to starting balance
      let failedCount = 0;
      for (const acct of userAccounts) {
        const isFailed =
          (acct.traded_days != null && acct.traded_days === 0) ||
          (acct.total_pnl != null && acct.starting_balance != null &&
            acct.total_pnl < -(acct.starting_balance * 0.08)) ||
          acct.is_blacklisted;

        if (isFailed) failedCount++;
      }

      const accountIds = userAccounts.map(a => a.platform_account_id);
      const totalAtRisk = userAccounts.reduce((sum, a) => sum + (a.balance || 0), 0);
      const failedRatio = userAccounts.length > 0 ? failedCount / userAccounts.length : 0;

      const confidence = computeConfidence(
        userAccounts.length,
        failedCount,
        config.max_accounts_per_user,
        config.failed_account_threshold
      );

      if (confidence < 20) continue;

      const severity = deriveSeverity(
        userAccounts.length,
        failedRatio,
        config.max_accounts_per_user
      );

      const firstName = userAccounts[0].first_name || '';
      const lastName = userAccounts[0].last_name || '';
      const country = userAccounts[0].country || 'unknown';

      findings.push({
        account_ids: accountIds,
        user_ids: [email],
        primary_account: accountIds[0],
        confidence_score: confidence,
        severity,
        title: `Account churning: ${email} (${userAccounts.length} accounts)`,
        summary:
          `User ${firstName} ${lastName} (${email}) has ${userAccounts.length} accounts ` +
          `(threshold: ${config.max_accounts_per_user}). ` +
          `${failedCount} appear failed/inactive (${(failedRatio * 100).toFixed(0)}% failure rate). ` +
          `Country: ${country}. Total balance at risk: $${totalAtRisk.toFixed(2)}.`,
        evidence: {
          detector: 'account_churning',
          run_timestamp: new Date().toISOString(),
          user_accounts: [{
            user_id: email,
            email,
            account_ids: accountIds,
            total_accounts: userAccounts.length,
            failed_accounts: failedCount,
          }],
        },
        total_amount_at_risk: totalAtRisk,
        recommended_action:
          severity === 'critical' || severity === 'high'
            ? 'Review user for potential abuse; consider account limits or ban'
            : 'Monitor user account creation patterns',
        dedupe_key: generateDedupeKey(email, accountIds),
      });
    }
  } catch (err) {
    logError('Account churning detector: unexpected error', err, {
      route: 'lib/fraud-hunter/detectors/account-churning',
      category: 'internal',
      tenant_id: tenantId,
    });
  }

  return { fraud_type: 'account_churning', findings };
}
