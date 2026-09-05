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
  deductions_total: number | null;
  deductions_by_type: Record<string, number> | null;
  num_approved_payouts: number | null;
  updated_at: string;
}

function generateDedupeKey(accountIds: string[]): string {
  const sorted = [...accountIds].sort();
  const today = new Date().toISOString().slice(0, 10);
  return `profit_manipulation:${sorted.join(':')}:${today}`;
}

function deriveSeverity(confidence: number): 'low' | 'medium' | 'high' | 'critical' {
  if (confidence >= 80) return 'critical';
  if (confidence >= 60) return 'high';
  if (confidence >= 40) return 'medium';
  return 'low';
}

/**
 * Detect profit manipulation patterns across related accounts.
 *
 * Since trade-level data is not in Supabase, this detector looks for:
 * - Users with multiple accounts where one has high deductions and another has high profits
 * - Accounts from different users (but with shared identity signals) showing inverse PnL patterns
 * - Accounts where deduction patterns suggest profit-shifting behavior
 */
export async function detectProfitManipulation(tenantId: string): Promise<FraudDetectorResult> {
  const findings: FraudFinding[] = [];
  const config = FRAUD_HUNTER_CONFIG.profit_manipulation;

  try {
    const db = tenantDb(tenantId, 'fraud-hunter profit-manipulation detector');

    const { data: snapshots, error } = await db
      .select(
        'account_snapshots',
        'platform_account_id, login, email, first_name, last_name, country, plan, ' +
        'starting_balance, balance, total_pnl, deductions_total, deductions_by_type, ' +
        'num_approved_payouts, updated_at'
      )
      .order('updated_at', { ascending: false })
      .limit(1000);

    if (error) {
      logError('Profit manipulation detector: failed to fetch snapshots', error, {
        route: 'lib/fraud-hunter/detectors/profit-manipulation',
        category: 'database',
        tenant_id: tenantId,
      });
      return { fraud_type: 'profit_manipulation', findings: [] };
    }

    if (!snapshots || snapshots.length < 2) {
      return { fraud_type: 'profit_manipulation', findings: [] };
    }

    const accounts = snapshots as unknown as AccountSnapshot[];

    // Group by email to find same-user multi-account setups
    const byEmail = new Map<string, AccountSnapshot[]>();
    for (const acct of accounts) {
      if (!acct.email) continue;
      const email = acct.email.toLowerCase();
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email)!.push(acct);
    }

    // Track reported clusters
    const reported = new Set<string>();

    // Check same-user multi-account setups for inverse PnL
    for (const [email, userAccounts] of byEmail) {
      if (userAccounts.length < 2) continue;

      // Look for pairs where one is profitable and one has high deductions
      for (let i = 0; i < userAccounts.length; i++) {
        for (let j = i + 1; j < userAccounts.length; j++) {
          const a = userAccounts[i];
          const b = userAccounts[j];

          if (!a.total_pnl || !b.total_pnl || !a.starting_balance || !b.starting_balance) continue;

          const pnlRatioA = a.total_pnl / a.starting_balance;
          const pnlRatioB = b.total_pnl / b.starting_balance;

          // Check for inverse pattern: one significantly profitable, other significantly losing
          const isInverse =
            (pnlRatioA > 0.02 && pnlRatioB < -0.02) ||
            (pnlRatioB > 0.02 && pnlRatioA < -0.02);

          if (!isInverse) continue;

          // Check if the losing side has high deductions
          const loser = pnlRatioA < pnlRatioB ? a : b;
          const winner = pnlRatioA < pnlRatioB ? b : a;

          const loserDeductions = loser.deductions_total || 0;
          const winnerPnl = winner.total_pnl || 0;

          // Is the deduction amount a significant portion of the profit transfer?
          const offsetRatio = winnerPnl > 0 && Math.abs(loser.total_pnl || 0) > 0
            ? Math.min(winnerPnl, Math.abs(loser.total_pnl || 0)) / Math.max(winnerPnl, Math.abs(loser.total_pnl || 0))
            : 0;

          if (offsetRatio < config.offset_threshold_pct) continue;

          const accountIds = [a.platform_account_id, b.platform_account_id];
          const clusterKey = [...accountIds].sort().join(':');
          if (reported.has(clusterKey)) continue;
          reported.add(clusterKey);

          let confidence = 0;
          // Strong inverse correlation
          confidence += Math.round(offsetRatio * 40);
          // Deduction involvement
          if (loserDeductions > 0) confidence += 20;
          // Same user controlling both
          confidence += 20;
          // High amounts
          if (winnerPnl > 1000) confidence += 10;
          if (Math.abs(loser.total_pnl || 0) > 1000) confidence += 10;

          confidence = Math.min(confidence, 100);
          if (confidence < 30) continue;

          const severity = deriveSeverity(confidence);
          const totalAtRisk = (winner.balance || 0) + (loser.balance || 0);
          const netTransfer = winnerPnl + (loser.total_pnl || 0);

          findings.push({
            account_ids: accountIds,
            user_ids: [email],
            primary_account: winner.platform_account_id,
            confidence_score: confidence,
            severity,
            title: `Profit manipulation: inverse PnL between ${email}'s accounts`,
            summary:
              `Two accounts owned by ${email} show inverse PnL patterns. ` +
              `Account ${winner.platform_account_id} (PnL: $${winnerPnl.toFixed(2)}) vs ` +
              `Account ${loser.platform_account_id} (PnL: $${(loser.total_pnl || 0).toFixed(2)}). ` +
              `Offset ratio: ${(offsetRatio * 100).toFixed(0)}%. ` +
              `Net transfer: $${netTransfer.toFixed(2)}. ` +
              `Loser deductions: $${loserDeductions.toFixed(2)}.`,
            evidence: {
              detector: 'profit_manipulation',
              run_timestamp: new Date().toISOString(),
              offsetting_trades: [{
                account_a: winner.platform_account_id,
                account_b: loser.platform_account_id,
                symbol: 'N/A (account-level analysis)',
                account_a_direction: 'profit',
                account_b_direction: 'loss',
                account_a_pnl: winnerPnl,
                account_b_pnl: loser.total_pnl || 0,
                net_transfer: netTransfer,
              }],
            },
            total_amount_at_risk: totalAtRisk,
            recommended_action:
              severity === 'critical' || severity === 'high'
                ? 'Block payouts on profitable account; investigate trade history for hedging/offsetting'
                : 'Review trade history for coordinated hedging patterns',
            dedupe_key: generateDedupeKey(accountIds),
          });
        }
      }
    }

    // Cross-user analysis: find accounts from different users with shared identity signals
    // and inverse PnL patterns
    const byCountry = new Map<string, AccountSnapshot[]>();
    for (const acct of accounts) {
      if (!acct.country || !acct.total_pnl || !acct.starting_balance) continue;
      const country = acct.country.toLowerCase();
      if (!byCountry.has(country)) byCountry.set(country, []);
      byCountry.get(country)!.push(acct);
    }

    for (const [country, countryAccounts] of byCountry) {
      if (countryAccounts.length < 2) continue;

      // Find pairs from different emails with inverse PnL
      const profitable = countryAccounts.filter(a =>
        a.total_pnl && a.starting_balance && (a.total_pnl / a.starting_balance) > 0.03
      );
      const losing = countryAccounts.filter(a =>
        a.total_pnl && a.starting_balance && (a.total_pnl / a.starting_balance) < -0.03
      );

      for (const winner of profitable) {
        for (const loser of losing) {
          // Must be different users
          if (winner.email && loser.email && winner.email.toLowerCase() === loser.email.toLowerCase()) continue;

          // Check name similarity
          const winnerName = `${winner.first_name || ''} ${winner.last_name || ''}`.trim().toLowerCase();
          const loserName = `${loser.first_name || ''} ${loser.last_name || ''}`.trim().toLowerCase();
          const sameNameDiffEmail = winnerName.length > 3 && winnerName === loserName;

          // Check email domain similarity
          const winnerDomain = winner.email?.split('@')[1]?.toLowerCase() || '';
          const loserDomain = loser.email?.split('@')[1]?.toLowerCase() || '';
          const sameDomain = winnerDomain.length > 5 && winnerDomain === loserDomain;

          if (!sameNameDiffEmail && !sameDomain) continue;

          const winnerPnl = winner.total_pnl || 0;
          const loserPnl = loser.total_pnl || 0;

          const offsetRatio =
            Math.min(Math.abs(winnerPnl), Math.abs(loserPnl)) /
            Math.max(Math.abs(winnerPnl), Math.abs(loserPnl));

          if (offsetRatio < config.offset_threshold_pct) continue;

          const accountIds = [winner.platform_account_id, loser.platform_account_id];
          const clusterKey = [...accountIds].sort().join(':');
          if (reported.has(clusterKey)) continue;
          reported.add(clusterKey);

          let confidence = 0;
          confidence += Math.round(offsetRatio * 30);
          if (sameNameDiffEmail) confidence += 25;
          if (sameDomain) confidence += 15;
          // Same country already established
          confidence += 10;

          confidence = Math.min(confidence, 100);
          if (confidence < 40) continue;

          const severity = deriveSeverity(confidence);
          const totalAtRisk = (winner.balance || 0) + (loser.balance || 0);
          const userIds = [winner.email, loser.email].filter(Boolean) as string[];

          findings.push({
            account_ids: accountIds,
            user_ids: userIds,
            primary_account: winner.platform_account_id,
            confidence_score: confidence,
            severity,
            title: `Cross-user profit manipulation (${country})`,
            summary:
              `Two accounts from different users in ${country} show inverse PnL patterns. ` +
              `${sameNameDiffEmail ? 'Same name, different emails. ' : ''}` +
              `${sameDomain ? `Same email domain (@${winnerDomain}). ` : ''}` +
              `Winner: ${winner.platform_account_id} (PnL: $${winnerPnl.toFixed(2)}), ` +
              `Loser: ${loser.platform_account_id} (PnL: $${loserPnl.toFixed(2)}). ` +
              `Offset ratio: ${(offsetRatio * 100).toFixed(0)}%.`,
            evidence: {
              detector: 'profit_manipulation',
              run_timestamp: new Date().toISOString(),
              offsetting_trades: [{
                account_a: winner.platform_account_id,
                account_b: loser.platform_account_id,
                symbol: 'N/A (account-level analysis)',
                account_a_direction: 'profit',
                account_b_direction: 'loss',
                account_a_pnl: winnerPnl,
                account_b_pnl: loserPnl,
                net_transfer: winnerPnl + loserPnl,
              }],
              shared_countries: [country],
            },
            total_amount_at_risk: totalAtRisk,
            recommended_action:
              'Investigate trade history for coordinated hedging between these accounts',
            dedupe_key: generateDedupeKey(accountIds),
          });
        }
      }
    }
  } catch (err) {
    logError('Profit manipulation detector: unexpected error', err, {
      route: 'lib/fraud-hunter/detectors/profit-manipulation',
      category: 'internal',
      tenant_id: tenantId,
    });
  }

  return { fraud_type: 'profit_manipulation', findings };
}
