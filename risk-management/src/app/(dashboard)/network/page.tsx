'use client';

import { useCallback, useEffect, useState } from 'react';
import { Share2, RefreshCw, Users, Waypoints, DollarSign } from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';
import { StatCard } from '@/components/ui/stat-card';
import { Button } from '@/components/ui/button';
import { NetworkGraphCanvas } from '@/components/network/graph-canvas';
import { ClusterPanel } from '@/components/network/cluster-panel';
import { useAssetClass } from '@/components/layout/provider-context';
import { formatCurrency } from '@/lib/utils/format';
import type { NetworkCluster, NetworkEdge, NetworkNode } from '@/lib/network/types';

interface NetworkGraphResponse {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  clusters: NetworkCluster[];
  exposure: { total: number; forex: number; futures: number };
}

const EMPTY_GRAPH: NetworkGraphResponse = {
  nodes: [],
  edges: [],
  clusters: [],
  exposure: { total: 0, forex: 0, futures: 0 },
};

export default function NetworkPage() {
  const assetClass = useAssetClass();
  const [graph, setGraph] = useState<NetworkGraphResponse>(EMPTY_GRAPH);
  const [loading, setLoading] = useState(true);
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/network/graph?assetClass=${assetClass}`, { cache: 'no-store' });
      const json = await res.json();
      setGraph(json.data ?? EMPTY_GRAPH);
    } catch {
      setGraph(EMPTY_GRAPH);
    } finally {
      setLoading(false);
    }
  }, [assetClass]);

  useEffect(() => {
    setSelectedClusterId(null);
    fetchGraph();
  }, [fetchGraph]);

  const handleSelectNode = (node: NetworkNode) => {
    if (!node.clusterId) {
      setSelectedClusterId(null);
      return;
    }
    setSelectedClusterId((prev) => (prev === node.clusterId ? null : node.clusterId!));
  };

  const selectedCluster = graph.clusters.find((c) => c.id === selectedClusterId) ?? null;
  const accountsInvolved = new Set(graph.clusters.flatMap((c) => c.accountIds)).size;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Share2 className="h-5 w-5 text-red-400" /> Network &amp; Ring Detection
          </h1>
          <p className="text-xs text-gray-500">
            Live cluster graph across {assetClass === 'futures' ? 'Futures' : 'Forex'} — copy rings, shared identity,
            and coordinated payouts, including cross-asset links invisible on a single-book dashboard.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={fetchGraph}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <StatCard title="Clusters Found" value={graph.clusters.length} icon={Waypoints} />
        <StatCard title="Accounts Involved" value={accountsInvolved} icon={Users} />
        <StatCard
          title="Exposure at Risk"
          value={formatCurrency(graph.exposure.total)}
          icon={DollarSign}
          subtitle={`Forex ${formatCurrency(graph.exposure.forex)} · Futures ${formatCurrency(graph.exposure.futures)}`}
        />
        <StatCard title="Graph Nodes" value={graph.nodes.length} icon={Share2} subtitle={`${graph.edges.length} linkages`} />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2">
          <GlassCard padding="sm">
            {loading && graph.nodes.length === 0 ? (
              <div className="flex h-[520px] items-center justify-center text-gray-500">
                <RefreshCw className="h-5 w-5 animate-spin mr-2" /> Building network graph...
              </div>
            ) : graph.nodes.length === 0 ? (
              <div className="flex h-[520px] flex-col items-center justify-center text-gray-500">
                <Share2 className="h-8 w-8 mb-2 opacity-30" />
                <p className="text-sm">No linked accounts detected for this asset class.</p>
              </div>
            ) : (
              <NetworkGraphCanvas
                nodes={graph.nodes}
                edges={graph.edges}
                selectedClusterId={selectedClusterId}
                onSelectNode={handleSelectNode}
              />
            )}
          </GlassCard>
        </div>

        <div>
          {selectedCluster ? (
            <ClusterPanel
              cluster={selectedCluster}
              nodes={graph.nodes}
              edges={graph.edges}
              onClose={() => setSelectedClusterId(null)}
            />
          ) : (
            <GlassCard padding="md" className="flex h-full flex-col items-center justify-center gap-2 text-center text-gray-500">
              <Waypoints className="h-6 w-6 opacity-30" />
              <p className="text-xs">Click a node to inspect its cluster — kind, confidence, members, and forensic evidence.</p>
            </GlassCard>
          )}
        </div>
      </div>
    </div>
  );
}
