'use client';

import { useState, useMemo } from 'react';
import { ShieldAlert, AlertTriangle, DollarSign, Clock } from 'lucide-react';
import { StatCard } from '@/components/ui/stat-card';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/ui/data-table';
import { InvestigationDetail } from '@/components/fraud/investigation-detail';
import { useFraudInvestigations } from '@/hooks/use-fraud-investigations';
import type { FraudInvestigation, FraudStatus, FraudType } from '@/types/fraud';

const fraudTypeBadge: Record<FraudType, { label: string; variant: 'purple' | 'blue' | 'yellow' | 'red' }> = {
  copy_ring: { label: 'Copy Ring', variant: 'purple' },
  shared_identity: { label: 'Shared Identity', variant: 'blue' },
  coordinated_payout: { label: 'Coordinated Payout', variant: 'yellow' },
  account_churning: { label: 'Account Churning', variant: 'red' },
  profit_manipulation: { label: 'Profit Manipulation', variant: 'red' },
};

const severityVariant: Record<string, 'silver' | 'yellow' | 'red'> = {
  low: 'silver',
  medium: 'yellow',
  high: 'red',
  critical: 'red',
};

const statusVariant: Record<string, 'blue' | 'yellow' | 'green' | 'silver' | 'red'> = {
  open: 'blue',
  reviewing: 'yellow',
  confirmed: 'red',
  dismissed: 'silver',
  actioned: 'green',
};

const statusOptions = [
  { value: '', label: 'All Statuses' },
  { value: 'open', label: 'Open' },
  { value: 'reviewing', label: 'Reviewing' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'actioned', label: 'Actioned' },
];

const fraudTypeOptions = [
  { value: '', label: 'All Types' },
  { value: 'copy_ring', label: 'Copy Ring' },
  { value: 'shared_identity', label: 'Shared Identity' },
  { value: 'coordinated_payout', label: 'Coordinated Payout' },
  { value: 'account_churning', label: 'Account Churning' },
  { value: 'profit_manipulation', label: 'Profit Manipulation' },
];

const severityOptions = [
  { value: '', label: 'All Severities' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return `${Math.floor(diffDay / 30)}mo ago`;
}

export function FraudHunterPanel() {
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [selectedInvestigation, setSelectedInvestigation] = useState<FraudInvestigation | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const { investigations, loading, error, scanning, refetch, runScan } = useFraudInvestigations({
    status: statusFilter || undefined,
    fraud_type: typeFilter || undefined,
    severity: severityFilter || undefined,
  });

  const stats = useMemo(() => {
    const openCount = investigations.filter((i) => i.status === 'open' || i.status === 'reviewing').length;
    const criticalCount = investigations.filter((i) => i.severity === 'critical').length;
    const totalAtRisk = investigations
      .filter((i) => i.status !== 'dismissed')
      .reduce((sum, i) => sum + i.total_amount_at_risk, 0);
    const lastDetected = investigations.length > 0
      ? investigations.reduce((latest, i) => (i.detected_at > latest ? i.detected_at : latest), investigations[0].detected_at)
      : null;
    return { openCount, criticalCount, totalAtRisk, lastDetected };
  }, [investigations]);

  const handleUpdateStatus = async (id: string, status: FraudStatus) => {
    try {
      const res = await fetch(`/api/fraud-hunter/investigations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetailOpen(false);
      setSelectedInvestigation(null);
      refetch();
    } catch {
      // Error handling is managed by the hook on refetch
    }
  };

  const columns = [
    {
      key: 'fraud_type',
      header: 'Type',
      render: (item: FraudInvestigation) => {
        const ft = fraudTypeBadge[item.fraud_type];
        return <Badge variant={ft.variant}>{ft.label}</Badge>;
      },
    },
    {
      key: 'severity',
      header: 'Severity',
      render: (item: FraudInvestigation) => (
        <Badge variant={severityVariant[item.severity]}>{item.severity.toUpperCase()}</Badge>
      ),
    },
    {
      key: 'title',
      header: 'Title',
      render: (item: FraudInvestigation) => (
        <span className="text-white font-medium max-w-[250px] truncate block">{item.title}</span>
      ),
    },
    {
      key: 'accounts',
      header: 'Accounts',
      render: (item: FraudInvestigation) => (
        <span className="text-gray-300">{item.account_ids.length}</span>
      ),
    },
    {
      key: 'confidence_score',
      header: 'Confidence',
      render: (item: FraudInvestigation) => {
        const color = item.confidence_score >= 80 ? 'text-red-400' :
                      item.confidence_score >= 60 ? 'text-yellow-400' :
                      'text-gray-400';
        return <span className={color}>{item.confidence_score}%</span>;
      },
    },
    {
      key: 'total_amount_at_risk',
      header: 'Amount at Risk',
      render: (item: FraudInvestigation) => (
        <span className="text-red-400 font-medium">${item.total_amount_at_risk.toLocaleString()}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (item: FraudInvestigation) => (
        <Badge variant={statusVariant[item.status]}>{item.status.toUpperCase()}</Badge>
      ),
    },
    {
      key: 'detected_at',
      header: 'Detected',
      render: (item: FraudInvestigation) => (
        <span className="text-gray-500">{relativeTime(item.detected_at)}</span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          title="Open Investigations"
          value={stats.openCount}
          icon={ShieldAlert}
          subtitle={`${investigations.length} total`}
        />
        <StatCard
          title="Critical"
          value={stats.criticalCount}
          icon={AlertTriangle}
          subtitle="Requires immediate action"
          className={stats.criticalCount > 0 ? 'border-red-500/30' : ''}
        />
        <StatCard
          title="Total at Risk"
          value={`$${stats.totalAtRisk.toLocaleString()}`}
          icon={DollarSign}
          subtitle="Non-dismissed investigations"
        />
        <StatCard
          title="Last Detection"
          value={stats.lastDetected ? relativeTime(stats.lastDetected) : 'N/A'}
          icon={Clock}
          subtitle={stats.lastDetected ? new Date(stats.lastDetected).toLocaleDateString() : 'No scans yet'}
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={statusFilter} onChange={setStatusFilter} options={statusOptions} placeholder="All Statuses" />
        <Select value={typeFilter} onChange={setTypeFilter} options={fraudTypeOptions} placeholder="All Types" />
        <Select value={severityFilter} onChange={setSeverityFilter} options={severityOptions} placeholder="All Severities" />
        <div className="ml-auto">
          <Button variant="primary" size="sm" loading={scanning} onClick={runScan}>
            {scanning ? 'Scanning...' : 'Run Fraud Scan'}
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Data table */}
      {loading && investigations.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-gray-500 text-sm">
          Loading investigations...
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={investigations}
          emptyMessage="No fraud investigations found. Run a scan to detect suspicious patterns."
          onRowClick={(item) => {
            setSelectedInvestigation(item);
            setDetailOpen(true);
          }}
        />
      )}

      {/* Investigation detail modal */}
      <InvestigationDetail
        investigation={selectedInvestigation}
        isOpen={detailOpen}
        onClose={() => {
          setDetailOpen(false);
          setSelectedInvestigation(null);
        }}
        onUpdateStatus={handleUpdateStatus}
      />
    </div>
  );
}
