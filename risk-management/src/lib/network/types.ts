/**
 * Network / ring graph shared types.
 *
 * A `NetworkGraph` is the visualizable form of a fraud-hunter-style finding:
 * accounts as nodes, linkages (copy correlation, shared identity, etc.) as
 * edges, and connected components as clusters. Shapes are provider-neutral
 * (account ids are the trading-platform string ids used across
 * `src/lib/mock`, `fraud_investigations.account_ids`, etc.), not the internal
 * `accounts.id` uuid.
 */

export type NetworkEdgeKind =
  | 'copy_correlation'
  | 'shared_identity'
  | 'coordinated_payout'
  | 'shared_ip'
  | 'shared_device';

export type NetworkRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface NetworkNode {
  id: string;
  label: string;
  assetClass: string;
  riskScore: number;
  riskLevel: NetworkRiskLevel;
  provider: string;
  clusterId?: string;
}

export interface NetworkEdge {
  source: string;
  target: string;
  kind: NetworkEdgeKind;
  /** Strength of the linkage, 0..1. */
  weight: number;
  detail: string;
}

export interface NetworkCluster {
  id: string;
  kind: NetworkEdgeKind | 'mixed';
  accountIds: string[];
  /** Confidence the cluster represents coordinated/fraudulent activity, 0..1. */
  confidence: number;
  severity: NetworkRiskLevel;
  summary: string;
  investigationId?: string;
}

export interface NetworkGraph {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  clusters: NetworkCluster[];
}
