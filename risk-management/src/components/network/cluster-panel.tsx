'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { X, Fingerprint, Globe2, Users, ShieldAlert, FileSearch, ExternalLink } from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { NetworkCluster, NetworkEdge, NetworkNode, NetworkRiskLevel } from '@/lib/network/types';

const SEVERITY_BADGE: Record<NetworkRiskLevel, 'red' | 'yellow' | 'blue' | 'silver'> = {
  critical: 'red',
  high: 'yellow',
  medium: 'blue',
  low: 'silver',
};

const KIND_LABEL: Record<NetworkCluster['kind'], string> = {
  copy_correlation: 'Copy Trading Ring',
  shared_identity: 'Shared Identity',
  coordinated_payout: 'Coordinated Payout',
  shared_ip: 'Shared IP',
  shared_device: 'Shared Device',
  mixed: 'Mixed Signal',
};

interface ClusterPanelProps {
  cluster: NetworkCluster;
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  onClose: () => void;
}

export function ClusterPanel({ cluster, nodes, edges, onClose }: ClusterPanelProps) {
  const router = useRouter();
  const [openingEvidence, setOpeningEvidence] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);

  const memberSet = new Set(cluster.accountIds);
  const members = nodes.filter((n) => memberSet.has(n.id));
  const forensicEdges = edges.filter(
    (e) => (e.kind === 'shared_ip' || e.kind === 'shared_device') && memberSet.has(e.source) && memberSet.has(e.target)
  );
  // De-dupe forensic detail lines (a complete-graph of pairs repeats the same detail string).
  const forensicDetails = Array.from(new Set(forensicEdges.map((e) => e.detail)));

  const handleOpenEvidence = async () => {
    setOpeningEvidence(true);
    setEvidenceError(null);
    try {
      const subjectId = cluster.investigationId || cluster.id;
      const res = await fetch('/api/evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectType: 'investigation', subjectId }),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const evidenceId = json?.id ?? json?.data?.id;
      if (!evidenceId) throw new Error('Evidence pack response missing id');
      router.push(`/evidence/${evidenceId}`);
    } catch (err) {
      setEvidenceError(err instanceof Error ? err.message : 'Failed to open evidence pack');
    } finally {
      setOpeningEvidence(false);
    }
  };

  return (
    <GlassCard padding="md" className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-red-400" />
            <span className="text-sm font-bold text-white">{KIND_LABEL[cluster.kind]}</span>
            <Badge variant={SEVERITY_BADGE[cluster.severity]}>{cluster.severity.toUpperCase()}</Badge>
          </div>
          <p className="mt-0.5 text-[10px] text-gray-500">
            {cluster.investigationId ? `Investigation ${cluster.investigationId}` : cluster.id} · {Math.round(cluster.confidence * 100)}% confidence
          </p>
        </div>
        <button onClick={onClose} className="shrink-0 rounded-lg p-1 text-gray-500 hover:bg-white/10 hover:text-gray-300">
          <X className="h-4 w-4" />
        </button>
      </div>

      <p className="text-xs leading-relaxed text-gray-300">{cluster.summary}</p>

      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          <Users className="h-3 w-3" /> Member Accounts ({members.length})
        </p>
        <div className="space-y-1">
          {members.map((m) => (
            <Link
              key={m.id}
              href={`/violations/account/${m.id}`}
              className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-gray-300 hover:border-red-500/30 hover:bg-white/10"
            >
              <span className="truncate">{m.label}</span>
              <ExternalLink className="h-3 w-3 shrink-0 text-gray-500" />
            </Link>
          ))}
        </div>
      </div>

      {forensicDetails.length > 0 && (
        <div>
          <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
            <Fingerprint className="h-3 w-3" /> Forensic Evidence
          </p>
          <div className="space-y-1.5">
            {forensicDetails.map((detail, i) => (
              <div key={i} className="flex items-start gap-1.5 text-[11px] text-gray-400">
                <Globe2 className="mt-0.5 h-3 w-3 shrink-0 text-red-400/70" />
                <span>{detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <Button variant="danger" size="sm" onClick={handleOpenEvidence} loading={openingEvidence} className="w-full">
          <FileSearch className="h-3.5 w-3.5" /> Open Evidence Pack
        </Button>
        {evidenceError && <p className="mt-1.5 text-[10px] text-red-400">{evidenceError}</p>}
      </div>
    </GlassCard>
  );
}
