/**
 * Demo-mode fraud-hunter investigations.
 *
 * `getFraudInvestigations`/`getFraudInvestigation` in `./persistence.ts` call
 * `createAdminClient()`, which throws in DEMO_MODE (no live Supabase). This
 * module synthesizes the same `FraudInvestigation` row shape the UI
 * (`src/components/fraud/*`) expects directly from the existing
 * `MOCK_NETWORK_CLUSTERS` ring dataset, so the fraud-hunter panel and
 * investigation-detail modal work in the sales demo without a database.
 *
 * Ids are the stable ring cluster ids (e.g. `RING-COPY-001`) so links and
 * refetches stay consistent across requests.
 */
import { FOREX_ACCOUNTS } from '@/lib/mock/dataset.forex';
import { FUTURES_ACCOUNTS } from '@/lib/mock/dataset.futures';
import { MOCK_NETWORK_CLUSTERS, type MockNetworkCluster } from '@/lib/mock/dataset.network';
import type { FraudEvidence, FraudInvestigation, FraudStatus, FraudType } from '@/types/fraud';

const KIND_TO_FRAUD_TYPE: Partial<Record<MockNetworkCluster['kind'], FraudType>> = {
  copy_correlation: 'copy_ring',
  shared_identity: 'shared_identity',
  coordinated_payout: 'coordinated_payout',
};

const FRAUD_TYPE_LABEL: Record<FraudType, string> = {
  copy_ring: 'Copy-Trading Ring',
  shared_identity: 'Shared-Identity Cluster',
  coordinated_payout: 'Coordinated Payout Cluster',
  account_churning: 'Account Churning',
  profit_manipulation: 'Profit Manipulation',
};

const RECOMMENDED_ACTION: Record<FraudType, string> = {
  copy_ring: 'Freeze pending payouts on all linked accounts and consolidate the profit-share calculation under a single beneficial owner.',
  shared_identity: 'Re-verify KYC identity documents across linked accounts before releasing further payouts.',
  coordinated_payout: 'Hold all clustered payouts pending a joint IP/device review across asset classes.',
  account_churning: 'Review account creation history for the linked user id before releasing further payouts.',
  profit_manipulation: 'Hold offsetting-trade accounts pending trade-tape review.',
};

function accountById(accountId: string) {
  return (
    FOREX_ACCOUNTS.find((a) => a.accountId === accountId) ||
    FUTURES_ACCOUNTS.find((a) => a.accountId === accountId) ||
    null
  );
}

function totalAmountAtRisk(cluster: MockNetworkCluster): number {
  return cluster.accountIds.reduce((sum, id) => sum + (accountById(id)?.payoutAmount || 0), 0);
}

function buildEvidence(cluster: MockNetworkCluster, fraudType: FraudType): FraudEvidence {
  const evidence: FraudEvidence = {
    detector: `${fraudType}_detector`,
    run_timestamp: cluster.detectedAt,
  };

  if (fraudType === 'copy_ring') {
    evidence.trade_correlations = cluster.edges
      .filter((e) => e.kind === 'copy_correlation')
      .map((e, idx) => ({
        symbol: idx % 2 === 0 ? 'EURUSD' : 'XAUUSD',
        account_a: e.source,
        account_b: e.target,
        time_lag_seconds: Number((1.4 + idx * 0.6).toFixed(1)),
        lot_ratio: Number((1 - idx * 0.03).toFixed(2)),
        count: 1,
      }));
    evidence.correlation_score = cluster.confidence;
  } else if (fraudType === 'shared_identity') {
    const domain = cluster.members[0]?.recoveryEmail?.split('@')[1];
    evidence.shared_emails = domain
      ? [{ pattern: `*@${domain}`, accounts: cluster.accountIds }]
      : undefined;
    evidence.shared_countries = cluster.members[0]?.country ? [cluster.members[0].country] : undefined;
  } else if (fraudType === 'coordinated_payout') {
    evidence.payout_cluster = cluster.members.map((m) => ({
      account_id: m.accountId,
      requested_at: cluster.detectedAt,
      amount: accountById(m.accountId)?.payoutAmount || 0,
    }));
    evidence.cluster_window_minutes = 21;
  }

  return evidence;
}

/** Convert one mock network ring cluster into a `FraudInvestigation` row. */
export function clusterToInvestigation(cluster: MockNetworkCluster): FraudInvestigation | null {
  const fraudType = KIND_TO_FRAUD_TYPE[cluster.kind];
  if (!fraudType) return null;

  return {
    id: cluster.id,
    fraud_type: fraudType,
    severity: cluster.severity,
    status: 'open',
    confidence_score: cluster.confidence,
    account_ids: cluster.accountIds,
    user_ids: [],
    primary_account: cluster.accountIds[0] || null,
    title: `${FRAUD_TYPE_LABEL[fraudType]} (${cluster.accountIds.length} accounts)`,
    summary: cluster.summary,
    evidence: buildEvidence(cluster, fraudType),
    total_amount_at_risk: totalAmountAtRisk(cluster),
    recommended_action: RECOMMENDED_ACTION[fraudType],
    resolved_by: null,
    resolved_at: null,
    resolution_notes: null,
    dedupe_key: cluster.id,
    detected_at: cluster.detectedAt,
    created_at: cluster.detectedAt,
    updated_at: cluster.detectedAt,
  };
}

/** All demo investigations, newest first (matches `getFraudInvestigations` ordering). */
export function getDemoInvestigations(filters?: {
  status?: FraudStatus[];
  fraud_type?: FraudType[];
  severity?: string[];
  limit?: number;
  offset?: number;
}): FraudInvestigation[] {
  let all = MOCK_NETWORK_CLUSTERS
    .map(clusterToInvestigation)
    .filter((inv): inv is FraudInvestigation => inv !== null)
    .sort((a, b) => (a.detected_at > b.detected_at ? -1 : 1));

  if (filters?.status?.length) all = all.filter((inv) => filters.status!.includes(inv.status));
  if (filters?.fraud_type?.length) all = all.filter((inv) => filters.fraud_type!.includes(inv.fraud_type));
  if (filters?.severity?.length) all = all.filter((inv) => filters.severity!.includes(inv.severity));

  const offset = filters?.offset ?? 0;
  const limit = filters?.limit ?? all.length;
  return all.slice(offset, offset + limit);
}

/** Single demo investigation by cluster id, or null if not found. */
export function getDemoInvestigation(id: string): FraudInvestigation | null {
  const cluster = MOCK_NETWORK_CLUSTERS.find((c) => c.id === id);
  return cluster ? clusterToInvestigation(cluster) : null;
}
