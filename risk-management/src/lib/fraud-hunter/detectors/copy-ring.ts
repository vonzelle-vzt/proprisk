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
  deductions_total: number | null;
  deductions_by_type: Record<string, number> | null;
  violation_count: number | null;
  num_approved_payouts: number | null;
  updated_at: string;
}

// Union-Find for connected components
class UnionFind {
  private parent: Map<string, string> = new Map();
  private rank: Map<string, number> = new Map();

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
    if (this.parent.get(x) !== x) {
      this.parent.set(x, this.find(this.parent.get(x)!));
    }
    return this.parent.get(x)!;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;

    const rankA = this.rank.get(rootA)!;
    const rankB = this.rank.get(rootB)!;

    if (rankA < rankB) {
      this.parent.set(rootA, rootB);
    } else if (rankA > rankB) {
      this.parent.set(rootB, rootA);
    } else {
      this.parent.set(rootB, rootA);
      this.rank.set(rootA, rankA + 1);
    }
  }

  getComponents(): Map<string, string[]> {
    const components = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      if (!components.has(root)) components.set(root, []);
      components.get(root)!.push(key);
    }
    return components;
  }
}

function computeSimilarity(a: AccountSnapshot, b: AccountSnapshot): number {
  let score = 0;
  let signals = 0;

  // Same country
  if (a.country && b.country && a.country === b.country) {
    score += 20;
    signals++;
  }

  // Same plan type
  if (a.plan && b.plan && a.plan === b.plan) {
    score += 15;
    signals++;
  }

  // Similar starting balance (within 10%)
  if (a.starting_balance && b.starting_balance) {
    const ratio = Math.min(a.starting_balance, b.starting_balance) /
      Math.max(a.starting_balance, b.starting_balance);
    if (ratio > 0.9) {
      score += 15;
      signals++;
    }
  }

  // Similar balance-to-starting ratio (trading pattern proxy)
  if (a.starting_balance && b.starting_balance && a.balance && b.balance) {
    const ratioA = a.balance / a.starting_balance;
    const ratioB = b.balance / b.starting_balance;
    const diff = Math.abs(ratioA - ratioB);
    if (diff < 0.05) {
      score += 20;
      signals++;
    } else if (diff < 0.1) {
      score += 10;
      signals++;
    }
  }

  // Similar traded days
  if (a.traded_days != null && b.traded_days != null) {
    const dayDiff = Math.abs(a.traded_days - b.traded_days);
    if (dayDiff <= 2) {
      score += 15;
      signals++;
    }
  }

  // Matching deduction types
  if (a.deductions_by_type && b.deductions_by_type) {
    const typesA = new Set(Object.keys(a.deductions_by_type));
    const typesB = new Set(Object.keys(b.deductions_by_type));
    const overlap = [...typesA].filter(t => typesB.has(t));
    if (overlap.length >= 2) {
      score += 15;
      signals++;
    }
  }

  // Different emails (must be different users to be suspicious)
  if (a.email && b.email && a.email !== b.email) {
    score += 0; // no penalty, just ensuring different users
  } else if (a.email && b.email && a.email === b.email) {
    // Same email = same user, not a copy ring signal
    return 0;
  }

  // Require at least 2 matching signals to count
  return signals >= 2 ? Math.min(score, 100) : 0;
}

function generateDedupeKey(accountIds: string[]): string {
  const sorted = [...accountIds].sort();
  const today = new Date().toISOString().slice(0, 10);
  return `copy_ring:${sorted.join(':')}:${today}`;
}

function deriveSeverity(score: number, ringSize: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score >= 80 && ringSize >= 4) return 'critical';
  if (score >= 60 || ringSize >= 3) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

/**
 * Detect potential copy trading rings by analyzing account similarity patterns.
 *
 * Since trade-level data is not available in Supabase (it requires user-token access),
 * this detector uses account_snapshots data to find suspicious clusters:
 * - Accounts from same country with matching plan types
 * - Similar balance patterns and traded days
 * - Similar deduction profiles
 */
export async function detectCopyRings(tenantId: string): Promise<FraudDetectorResult> {
  const findings: FraudFinding[] = [];
  const config = FRAUD_HUNTER_CONFIG.copy_ring;

  try {
    const db = tenantDb(tenantId, 'fraud-hunter copy-ring detector');

    // Fetch recent account snapshots (last 30 days of updates)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);

    const { data: snapshots, error } = await db
      .select(
        'account_snapshots',
        'platform_account_id, login, email, first_name, last_name, country, plan, ' +
        'starting_balance, balance, total_pnl, traded_days, deductions_total, ' +
        'deductions_by_type, violation_count, num_approved_payouts, updated_at'
      )
      .gte('updated_at', cutoff.toISOString())
      .order('updated_at', { ascending: false })
      .limit(500);

    if (error) {
      logError('Copy ring detector: failed to fetch snapshots', error, {
        route: 'lib/fraud-hunter/detectors/copy-ring',
        category: 'database',
        tenant_id: tenantId,
      });
      return { fraud_type: 'copy_ring', findings: [] };
    }

    if (!snapshots || snapshots.length < config.min_ring_size) {
      return { fraud_type: 'copy_ring', findings: [] };
    }

    const accounts = snapshots as unknown as AccountSnapshot[];
    const uf = new UnionFind();
    const pairScores = new Map<string, number>();

    // Compare all pairs — build adjacency graph
    for (let i = 0; i < accounts.length; i++) {
      for (let j = i + 1; j < accounts.length; j++) {
        const similarity = computeSimilarity(accounts[i], accounts[j]);
        const threshold = config.correlation_threshold * 100;

        if (similarity >= threshold) {
          uf.union(accounts[i].platform_account_id, accounts[j].platform_account_id);
          const key = [accounts[i].platform_account_id, accounts[j].platform_account_id].sort().join(':');
          pairScores.set(key, similarity);
        }
      }
    }

    // Extract connected components (rings)
    const components = uf.getComponents();
    const accountMap = new Map(accounts.map(a => [a.platform_account_id, a]));

    for (const [, members] of components) {
      if (members.length < config.min_ring_size) continue;

      // Compute average score across ring pairs
      let totalScore = 0;
      let pairCount = 0;
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const key = [members[i], members[j]].sort().join(':');
          const score = pairScores.get(key);
          if (score != null) {
            totalScore += score;
            pairCount++;
          }
        }
      }
      const avgScore = pairCount > 0 ? totalScore / pairCount : 0;

      // Gather member details
      const memberAccounts = members.map(id => accountMap.get(id)).filter(Boolean) as AccountSnapshot[];
      const userIds = [...new Set(memberAccounts.map(a => a.email).filter(Boolean))] as string[];
      const totalAtRisk = memberAccounts.reduce((sum, a) => sum + (a.balance || 0), 0);
      const countries = [...new Set(memberAccounts.map(a => a.country).filter(Boolean))];

      const severity = deriveSeverity(avgScore, members.length);

      findings.push({
        account_ids: members,
        user_ids: userIds,
        primary_account: members[0],
        confidence_score: Math.round(avgScore),
        severity,
        title: `Potential copy trading ring (${members.length} accounts)`,
        summary:
          `Detected ${members.length} accounts with highly similar trading patterns. ` +
          `Countries: ${countries.join(', ') || 'unknown'}. ` +
          `Average similarity score: ${avgScore.toFixed(1)}/100. ` +
          `Total balance at risk: $${totalAtRisk.toFixed(2)}.`,
        evidence: {
          detector: 'copy_ring',
          run_timestamp: new Date().toISOString(),
          correlation_score: avgScore,
          shared_countries: countries as string[],
        },
        total_amount_at_risk: totalAtRisk,
        recommended_action:
          severity === 'critical' || severity === 'high'
            ? 'Block payouts and investigate trade history via foreign session'
            : 'Monitor accounts and review trade history when available',
        dedupe_key: generateDedupeKey(members),
      });
    }
  } catch (err) {
    logError('Copy ring detector: unexpected error', err, {
      route: 'lib/fraud-hunter/detectors/copy-ring',
      category: 'internal',
      tenant_id: tenantId,
    });
  }

  return { fraud_type: 'copy_ring', findings };
}
