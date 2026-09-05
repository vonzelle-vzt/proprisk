/**
 * Network / ring graph builder.
 *
 * Produces the provider-neutral `NetworkGraph` (nodes/edges/clusters, see
 * `./types.ts`) consumed by `GET /api/network/graph` and rendered on
 * `/network`. Mirrors the demo/live split used across the rest of the
 * platform (`src/lib/demo`): DEMO_MODE composes a coherent graph from the
 * mock fraud-hunter dataset; live mode reads persisted fraud investigations.
 */
import { DEMO_MODE, type AssetClass } from '@/lib/demo';
import { FOREX_ACCOUNTS, type MockAccount } from '@/lib/mock/dataset.forex';
import { FUTURES_ACCOUNTS } from '@/lib/mock/dataset.futures';
import { MOCK_NETWORK_CLUSTERS, type MockNetworkCluster, type MockAssetClass } from '@/lib/mock/dataset.network';
import { getFraudInvestigations } from '@/lib/fraud-hunter/persistence';
import type { FraudInvestigation, FraudType } from '@/types/fraud';
import type { NetworkCluster, NetworkEdge, NetworkEdgeKind, NetworkGraph, NetworkNode, NetworkRiskLevel } from './types';

export interface BuildNetworkGraphParams {
  /** Optional asset-class filter — mirrors the global Forex/Futures toggle. */
  assetClass?: AssetClass;
  /**
   * Tenant to scope the live graph to. Optional in the type only so
   * DEMO_MODE callers (which have no session/tenant) don't need to pass one;
   * `buildLiveGraph` asserts it at runtime — see the note there. Every live
   * (non-demo) caller MUST pass this.
   */
  tenantId?: string;
}

/** Estimated payout exposure sitting inside detected clusters, split by asset class. */
export interface NetworkExposure {
  total: number;
  forex: number;
  futures: number;
}

export interface NetworkGraphResult extends NetworkGraph {
  exposure: NetworkExposure;
}

// ---------------------------------------------------------------------------
// Risk heuristic (demo) — cheap stand-in for computeRiskScore (which expects
// PlatformAccount/PlatformUser shapes we don't have for mock accounts) that
// still scores on the same signals: deduction concentration, violation-type
// spread, blacklist, KYC.
// ---------------------------------------------------------------------------

const SEVERITY_FLOOR: Record<NetworkRiskLevel, number> = {
  critical: 85,
  high: 65,
  medium: 40,
  low: 20,
};

function riskLevelFromScore(score: number): NetworkRiskLevel {
  if (score >= 70) return 'critical';
  if (score >= 45) return 'high';
  if (score >= 20) return 'medium';
  return 'low';
}

function accountRiskScore(a: MockAccount): number {
  let score = 0;
  const totalDed = Object.values(a.deductionBreakdown).reduce((s, v) => s + v, 0);
  if (a.totalPnL > 0) {
    const pct = (totalDed / a.totalPnL) * 100;
    if (pct > 50) score += 40;
    else if (pct > 20) score += 25;
    else if (pct > 5) score += 10;
  }
  const violationTypeCount = Object.keys(a.deductionBreakdown).length;
  if (violationTypeCount >= 3) score += 20;
  else if (violationTypeCount >= 2) score += 10;
  if (a.isBlackListed) score += 30;
  if (a.kycStatus !== 'Verified') score += 10;
  return Math.min(100, score);
}

/** Mask a trader's name for display: first-initial + last name. */
function maskName(a: Pick<MockAccount, 'firstName' | 'lastName'>): string {
  return `${a.firstName.charAt(0)}. ${a.lastName}`;
}

function nodeLabel(a: MockAccount): string {
  return `${maskName(a)} — ${a.accountId}`;
}

function toNode(a: MockAccount, assetClass: MockAssetClass, clusterFloor?: number, clusterId?: string): NetworkNode {
  const score = Math.max(accountRiskScore(a), clusterFloor ?? 0);
  return {
    id: a.accountId,
    label: nodeLabel(a),
    assetClass,
    riskScore: score,
    riskLevel: riskLevelFromScore(score),
    provider: a.provider,
    clusterId,
  };
}

/** Complete-graph pairwise edges for a shared signal (IP/device) across cluster members. */
function pairwiseEdges(accountIds: string[], kind: NetworkEdgeKind, weight: number, detail: string): NetworkEdge[] {
  const edges: NetworkEdge[] = [];
  for (let i = 0; i < accountIds.length; i++) {
    for (let j = i + 1; j < accountIds.length; j++) {
      edges.push({ source: accountIds[i], target: accountIds[j], kind, weight, detail });
    }
  }
  return edges;
}

function clusterAssetClasses(cluster: MockNetworkCluster): Set<MockAssetClass> {
  return new Set(cluster.members.map((m) => m.assetClass));
}

async function buildDemoGraph(params: BuildNetworkGraphParams): Promise<NetworkGraphResult> {
  const nodesById = new Map<string, NetworkNode>();
  const edges: NetworkEdge[] = [];
  const clusters: NetworkCluster[] = [];
  const exposure: NetworkExposure = { total: 0, forex: 0, futures: 0 };
  const exposureCounted = new Set<string>();

  const requestedAssetClass = params.assetClass;

  for (const cluster of MOCK_NETWORK_CLUSTERS) {
    const spansMultiple = clusterAssetClasses(cluster).size > 1;
    // Cross-asset clusters stay visible regardless of which side of the
    // toggle is active — that cross-visibility is the point of the feature.
    if (requestedAssetClass && !spansMultiple && !clusterAssetClasses(cluster).has(requestedAssetClass)) {
      continue;
    }

    const severityFloor = SEVERITY_FLOOR[cluster.severity];
    for (const member of cluster.members) {
      const account = [...FOREX_ACCOUNTS, ...FUTURES_ACCOUNTS].find((a) => a.accountId === member.accountId);
      if (!account) continue;
      nodesById.set(account.accountId, toNode(account, member.assetClass, severityFloor, cluster.id));

      if (!exposureCounted.has(account.accountId)) {
        exposureCounted.add(account.accountId);
        exposure.total += account.payoutAmount;
        exposure[member.assetClass] += account.payoutAmount;
      }
    }

    edges.push(...cluster.edges);
    if (cluster.sharedIp) {
      edges.push(...pairwiseEdges(cluster.accountIds, 'shared_ip', 0.7, `Shared submission IP address ${cluster.sharedIp}`));
    }
    if (cluster.sharedDevice) {
      edges.push(...pairwiseEdges(cluster.accountIds, 'shared_device', 0.75, `Shared device fingerprint ${cluster.sharedDevice}`));
    }

    clusters.push({
      id: cluster.id,
      kind: cluster.kind,
      accountIds: cluster.accountIds,
      confidence: cluster.confidence,
      severity: cluster.severity,
      summary: cluster.summary,
      investigationId: cluster.investigationId,
    });
  }

  // Context nodes: a handful of high-risk accounts not already in a ring, so
  // the graph reads as a real book rather than three isolated islands.
  const clusteredIds = new Set(nodesById.keys());
  const contextPool: Array<{ account: MockAccount; assetClass: MockAssetClass }> = [];
  if (!requestedAssetClass || requestedAssetClass === 'forex') {
    contextPool.push(...FOREX_ACCOUNTS.map((account) => ({ account, assetClass: 'forex' as const })));
  }
  if (!requestedAssetClass || requestedAssetClass === 'futures') {
    contextPool.push(...FUTURES_ACCOUNTS.map((account) => ({ account, assetClass: 'futures' as const })));
  }

  const contextCandidates = contextPool
    .filter(({ account }) => !clusteredIds.has(account.accountId))
    .sort((a, b) => accountRiskScore(b.account) - accountRiskScore(a.account))
    .slice(0, 8);

  for (const { account, assetClass } of contextCandidates) {
    nodesById.set(account.accountId, toNode(account, assetClass));
  }

  return { nodes: Array.from(nodesById.values()), edges, clusters, exposure };
}

// ---------------------------------------------------------------------------
// Live graph — persisted fraud investigations.
// ---------------------------------------------------------------------------

const FRAUD_TYPE_TO_EDGE_KIND: Record<FraudType, NetworkEdgeKind> = {
  copy_ring: 'copy_correlation',
  shared_identity: 'shared_identity',
  coordinated_payout: 'coordinated_payout',
  account_churning: 'shared_identity',
  profit_manipulation: 'coordinated_payout',
};

function investigationToCluster(inv: FraudInvestigation): NetworkCluster {
  return {
    id: inv.id,
    kind: FRAUD_TYPE_TO_EDGE_KIND[inv.fraud_type] ?? 'mixed',
    accountIds: inv.account_ids,
    confidence: inv.confidence_score,
    severity: inv.severity,
    summary: inv.summary,
    investigationId: inv.id,
  };
}

async function buildLiveGraph(params: BuildNetworkGraphParams): Promise<NetworkGraphResult> {
  // NOTE: fraud_investigations rows don't carry asset class today, so the
  // `assetClass` filter is a no-op in live mode (deviation — see route notes),
  // and exposure can't be split forex/futures — it's all folded into `total`.
  //
  // tenantId is optional on BuildNetworkGraphParams (DEMO_MODE has no
  // session), but this branch only ever runs outside DEMO_MODE — the caller
  // must supply the tenant from its auth guard. `getFraudInvestigations`
  // would throw MissingTenantError anyway; failing here with a clearer
  // message first.
  if (!params.tenantId) {
    throw new Error('buildNetworkGraph: tenantId is required outside DEMO_MODE');
  }
  const investigations = await getFraudInvestigations(params.tenantId, {
    status: ['open', 'reviewing', 'confirmed'],
  });

  const nodesById = new Map<string, NetworkNode>();
  const edges: NetworkEdge[] = [];
  const clusters: NetworkCluster[] = [];
  const exposure: NetworkExposure = { total: 0, forex: 0, futures: 0 };

  for (const inv of investigations) {
    exposure.total += inv.total_amount_at_risk;
    const kind: NetworkEdgeKind = FRAUD_TYPE_TO_EDGE_KIND[inv.fraud_type];
    const severityFloor = SEVERITY_FLOOR[inv.severity as NetworkRiskLevel] ?? 40;

    for (const accountId of inv.account_ids) {
      const existing = nodesById.get(accountId);
      const score = Math.max(existing?.riskScore ?? 0, severityFloor);
      nodesById.set(accountId, {
        id: accountId,
        label: accountId,
        assetClass: 'forex',
        riskScore: score,
        riskLevel: riskLevelFromScore(score),
        provider: 'unknown',
        clusterId: inv.id,
      });
    }

    edges.push(...pairwiseEdges(inv.account_ids, kind, inv.confidence_score, inv.summary));

    clusters.push(investigationToCluster(inv));
  }

  return { nodes: Array.from(nodesById.values()), edges, clusters, exposure };
}

export async function buildNetworkGraph(params: BuildNetworkGraphParams = {}): Promise<NetworkGraphResult> {
  if (DEMO_MODE) return buildDemoGraph(params);
  return buildLiveGraph(params);
}
