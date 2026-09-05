import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('buildNetworkGraph (demo mode)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('includes a node for every member of every mock cluster', async () => {
    const { buildNetworkGraph } = await import('./graph');
    const { MOCK_NETWORK_CLUSTERS } = await import('@/lib/mock/dataset.network');

    const graph = await buildNetworkGraph();
    const nodeIds = new Set(graph.nodes.map((n) => n.id));

    for (const cluster of MOCK_NETWORK_CLUSTERS) {
      for (const accountId of cluster.accountIds) {
        expect(nodeIds.has(accountId)).toBe(true);
      }
    }
  });

  it('produces a pairwise edge set for the copy-ring cluster typed as copy_correlation', async () => {
    const { buildNetworkGraph } = await import('./graph');
    const { MOCK_COPY_RING } = await import('@/lib/mock/dataset.network');

    const graph = await buildNetworkGraph();
    const ringEdges = graph.edges.filter(
      (e) => MOCK_COPY_RING.accountIds.includes(e.source) && MOCK_COPY_RING.accountIds.includes(e.target)
    );
    expect(ringEdges.length).toBeGreaterThan(0);
    // The ring also carries shared_ip/shared_device edges (the cluster has
    // both signals set), so assert at least one copy_correlation edge exists
    // rather than requiring every edge to be that kind.
    expect(ringEdges.some((e) => e.kind === 'copy_correlation')).toBe(true);
  });

  it('produces shared_identity-typed edges for the identity cluster', async () => {
    const { buildNetworkGraph } = await import('./graph');
    const { MOCK_SHARED_IDENTITY_CLUSTER } = await import('@/lib/mock/dataset.network');

    const graph = await buildNetworkGraph();
    const identityEdges = graph.edges.filter(
      (e) =>
        MOCK_SHARED_IDENTITY_CLUSTER.accountIds.includes(e.source) &&
        MOCK_SHARED_IDENTITY_CLUSTER.accountIds.includes(e.target) &&
        e.kind === 'shared_identity'
    );
    expect(identityEdges.length).toBeGreaterThan(0);
  });

  it('keeps the cross-asset coordinated-payout cluster visible under both asset-class filters', async () => {
    const { buildNetworkGraph } = await import('./graph');
    const { MOCK_COORDINATED_PAYOUT_CLUSTER } = await import('@/lib/mock/dataset.network');

    const forexGraph = await buildNetworkGraph({ assetClass: 'forex' });
    const futuresGraph = await buildNetworkGraph({ assetClass: 'futures' });

    const forexHasCluster = forexGraph.clusters.some((c) => c.id === MOCK_COORDINATED_PAYOUT_CLUSTER.id);
    const futuresHasCluster = futuresGraph.clusters.some((c) => c.id === MOCK_COORDINATED_PAYOUT_CLUSTER.id);

    expect(forexHasCluster).toBe(true);
    expect(futuresHasCluster).toBe(true);

    // Every member of the cross-asset cluster should have a node present
    // under both filters, since spanning-multiple-classes clusters are
    // exempt from the asset-class filter.
    for (const accountId of MOCK_COORDINATED_PAYOUT_CLUSTER.accountIds) {
      expect(forexGraph.nodes.some((n) => n.id === accountId)).toBe(true);
      expect(futuresGraph.nodes.some((n) => n.id === accountId)).toBe(true);
    }
  });

  it('computes non-negative exposure totals that reconcile with forex + futures splits', async () => {
    const { buildNetworkGraph } = await import('./graph');

    const graph = await buildNetworkGraph();
    expect(graph.exposure.total).toBeGreaterThanOrEqual(0);
    expect(graph.exposure.forex).toBeGreaterThanOrEqual(0);
    expect(graph.exposure.futures).toBeGreaterThanOrEqual(0);
    expect(graph.exposure.total).toBeCloseTo(graph.exposure.forex + graph.exposure.futures, 5);
  });

  it('includes a handful of unclustered high-risk context nodes alongside ring members', async () => {
    const { buildNetworkGraph } = await import('./graph');
    const { MOCK_NETWORK_CLUSTERS } = await import('@/lib/mock/dataset.network');

    const graph = await buildNetworkGraph();
    const clusteredIds = new Set(MOCK_NETWORK_CLUSTERS.flatMap((c) => c.accountIds));
    const contextNodes = graph.nodes.filter((n) => !clusteredIds.has(n.id));
    expect(contextNodes.length).toBeGreaterThan(0);
    expect(contextNodes.every((n) => n.clusterId === undefined)).toBe(true);
  });
});
