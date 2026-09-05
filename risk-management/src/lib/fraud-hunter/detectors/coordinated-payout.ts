import { tenantDb } from '@/lib/db/tenant-scoped';
import { logError } from '@/lib/logging/logger';
import { FRAUD_HUNTER_CONFIG } from '@/config/fraud-hunter';
import type { FraudDetectorResult, FraudFinding } from '@/types/fraud';

interface PendingPayout {
  platform_payout_id: string;
  platform_account_id: string;
  login: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  country: string | null;
  amount: number | null;
  client_amount: number | null;
  date_requested: string | null;
  decided_at: string | null;
  created_at: string;
}

interface PayoutCluster {
  payouts: PendingPayout[];
  startTime: number;
  endTime: number;
}

function generateDedupeKey(accountIds: string[]): string {
  const sorted = [...accountIds].sort();
  const today = new Date().toISOString().slice(0, 10);
  return `coordinated_payout:${sorted.join(':')}:${today}`;
}

function deriveSeverity(
  clusterSize: number,
  identityOverlap: number,
  totalAmount: number
): 'low' | 'medium' | 'high' | 'critical' {
  if (clusterSize >= 5 && identityOverlap > 0) return 'critical';
  if (clusterSize >= 4 || (clusterSize >= 3 && identityOverlap > 0)) return 'high';
  if (totalAmount >= 10000 || clusterSize >= 3) return 'medium';
  return 'low';
}

function computeConfidence(
  clusterSize: number,
  windowMinutes: number,
  identityOverlap: number,
  configWindow: number
): number {
  let score = 0;

  // Timing tightness — closer = more suspicious
  const tightnessRatio = 1 - (windowMinutes / configWindow);
  score += Math.round(tightnessRatio * 40);

  // Cluster size
  if (clusterSize >= 5) score += 30;
  else if (clusterSize >= 4) score += 25;
  else if (clusterSize >= 3) score += 15;

  // Identity overlap (shared country, email domain, name)
  score += Math.min(identityOverlap * 10, 30);

  return Math.min(Math.max(score, 0), 100);
}

/**
 * Detect coordinated payout timing patterns.
 *
 * Looks for clusters of pending payouts requested within a tight time window,
 * then cross-references with account data for identity overlap signals.
 */
export async function detectCoordinatedPayouts(tenantId: string): Promise<FraudDetectorResult> {
  const findings: FraudFinding[] = [];
  const config = FRAUD_HUNTER_CONFIG.coordinated_payout;

  try {
    const db = tenantDb(tenantId, 'fraud-hunter coordinated-payout detector');

    // Fetch pending payouts from payout_history
    const { data: pendingPayouts, error } = await db
      .select(
        'payout_history',
        'platform_payout_id, platform_account_id, login, email, first_name, last_name, ' +
        'country, amount, client_amount, date_requested, decided_at, created_at'
      )
      .eq('decision', 'pending')
      .order('created_at', { ascending: true })
      .limit(500);

    if (error) {
      logError('Coordinated payout detector: failed to fetch pending payouts', error, {
        route: 'lib/fraud-hunter/detectors/coordinated-payout',
        category: 'database',
        tenant_id: tenantId,
      });
      return { fraud_type: 'coordinated_payout', findings: [] };
    }

    if (!pendingPayouts || pendingPayouts.length < config.min_cluster_size) {
      return { fraud_type: 'coordinated_payout', findings: [] };
    }

    const payouts = pendingPayouts as unknown as PendingPayout[];

    // Sort by request time
    payouts.sort((a, b) => {
      const timeA = new Date(a.date_requested || a.created_at).getTime();
      const timeB = new Date(b.date_requested || b.created_at).getTime();
      return timeA - timeB;
    });

    // Sliding window to find clusters
    const windowMs = config.cluster_window_minutes * 60 * 1000;
    const clusters: PayoutCluster[] = [];
    let clusterStart = 0;

    for (let i = 0; i < payouts.length; i++) {
      const currentTime = new Date(payouts[i].date_requested || payouts[i].created_at).getTime();

      // Move cluster start forward until within window
      while (clusterStart < i) {
        const startTime = new Date(
          payouts[clusterStart].date_requested || payouts[clusterStart].created_at
        ).getTime();
        if (currentTime - startTime > windowMs) {
          clusterStart++;
        } else {
          break;
        }
      }

      const clusterPayouts = payouts.slice(clusterStart, i + 1);
      if (clusterPayouts.length >= config.min_cluster_size) {
        // Check if this cluster is substantially different from the last one
        const startTime = new Date(
          clusterPayouts[0].date_requested || clusterPayouts[0].created_at
        ).getTime();
        const endTime = currentTime;

        const lastCluster = clusters[clusters.length - 1];
        if (
          !lastCluster ||
          clusterPayouts.length > lastCluster.payouts.length ||
          startTime !== lastCluster.startTime
        ) {
          clusters.push({ payouts: [...clusterPayouts], startTime, endTime });
        }
      }
    }

    // Deduplicate overlapping clusters — keep the largest
    const deduped: PayoutCluster[] = [];
    for (const cluster of clusters) {
      const existingIdx = deduped.findIndex(d =>
        d.payouts.some(p => cluster.payouts.some(cp =>
          cp.platform_payout_id === p.platform_payout_id
        ))
      );
      if (existingIdx >= 0) {
        if (cluster.payouts.length > deduped[existingIdx].payouts.length) {
          deduped[existingIdx] = cluster;
        }
      } else {
        deduped.push(cluster);
      }
    }

    // Analyze each cluster
    for (const cluster of deduped) {
      const accountIds = [...new Set(cluster.payouts.map(p => p.platform_account_id))];
      if (accountIds.length < config.min_cluster_size) continue;

      const totalAmount = cluster.payouts.reduce(
        (sum, p) => sum + (p.amount || p.client_amount || 0), 0
      );
      if (totalAmount < config.min_total_amount) continue;

      // Identity overlap analysis
      let identityOverlap = 0;
      const countries = cluster.payouts.map(p => p.country).filter(Boolean);
      const uniqueCountries = new Set(countries);
      if (uniqueCountries.size === 1 && countries.length >= 2) identityOverlap++;

      const emails = cluster.payouts.map(p => p.email).filter(Boolean) as string[];
      const domains = emails.map(e => e.split('@')[1]?.toLowerCase()).filter(Boolean);
      const uniqueDomains = new Set(domains);
      if (uniqueDomains.size === 1 && domains.length >= 2) identityOverlap++;

      const names = cluster.payouts
        .map(p => `${p.first_name || ''} ${p.last_name || ''}`.trim().toLowerCase())
        .filter(n => n.length > 0);
      const uniqueNames = new Set(names);
      if (uniqueNames.size < names.length) identityOverlap++; // duplicated names

      const windowMinutes = (cluster.endTime - cluster.startTime) / (60 * 1000);
      const confidence = computeConfidence(
        accountIds.length, windowMinutes, identityOverlap, config.cluster_window_minutes
      );
      const severity = deriveSeverity(accountIds.length, identityOverlap, totalAmount);

      const userIds = [...new Set(cluster.payouts.map(p => p.email).filter(Boolean))] as string[];

      findings.push({
        account_ids: accountIds,
        user_ids: userIds,
        primary_account: accountIds[0],
        confidence_score: confidence,
        severity,
        title: `Coordinated payout cluster (${accountIds.length} accounts, ${windowMinutes.toFixed(0)}min window)`,
        summary:
          `${accountIds.length} accounts requested payouts within ${windowMinutes.toFixed(0)} minutes. ` +
          `Total amount: $${totalAmount.toFixed(2)}. ` +
          `${identityOverlap > 0 ? `Identity overlap detected (${identityOverlap} signal${identityOverlap > 1 ? 's' : ''}).` : 'No identity overlap detected.'} ` +
          `Countries: ${[...uniqueCountries].join(', ') || 'unknown'}.`,
        evidence: {
          detector: 'coordinated_payout',
          run_timestamp: new Date().toISOString(),
          payout_cluster: cluster.payouts.map(p => ({
            account_id: p.platform_account_id,
            requested_at: p.date_requested || p.created_at,
            amount: p.amount || p.client_amount || 0,
          })),
          cluster_window_minutes: windowMinutes,
          shared_countries: uniqueCountries.size === 1 ? [...uniqueCountries] as string[] : [],
        },
        total_amount_at_risk: totalAmount,
        recommended_action:
          severity === 'critical' || severity === 'high'
            ? 'Hold all payouts in cluster and investigate identity links'
            : 'Review payout timing and check for additional correlations',
        dedupe_key: generateDedupeKey(accountIds),
      });
    }
  } catch (err) {
    logError('Coordinated payout detector: unexpected error', err, {
      route: 'lib/fraud-hunter/detectors/coordinated-payout',
      category: 'internal',
      tenant_id: tenantId,
    });
  }

  return { fraud_type: 'coordinated_payout', findings };
}
