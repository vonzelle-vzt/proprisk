'use client';

import { StatCard } from '@/components/ui/stat-card';
import {
  CheckCircle,
  AlertCircle,
  XCircle,
  Activity,
  Clock,
  FileSearch,
} from 'lucide-react';

interface ReviewerRun {
  id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  total_cases: number;
  confirmed: number;
  pending_deduction: number;
  errors: number;
  skipped: number;
  platform_healthy: boolean;
  created_at: string;
}

interface ReviewerStatsData {
  total_reviewed: number;
  confirmed: number;
  pending_deduction: number;
  errors: number;
  total_runs: number;
  last_run: ReviewerRun | null;
}

interface ReviewerStatsProps {
  stats: ReviewerStatsData | null;
  loading?: boolean;
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  if (diffMs < 0) return 'just now';

  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getRunStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
    case 'deferred': return 'Deferred';
    case 'running': return 'Running';
    default: return 'Never Run';
  }
}

export function ReviewerStats({ stats, loading }: ReviewerStatsProps) {
  const lastRun = stats?.last_run;
  const confirmRate = stats && stats.total_reviewed > 0
    ? Math.round((stats.confirmed / stats.total_reviewed) * 100)
    : 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          title="Last Run"
          value={loading ? '...' : formatRelativeTime(lastRun?.completed_at ?? lastRun?.created_at ?? null)}
          subtitle={loading ? '' : getRunStatusLabel(lastRun?.status)}
          icon={Clock}
          className={lastRun?.status === 'failed' ? 'border-red-500/30' : lastRun?.status === 'deferred' ? 'border-yellow-500/30' : undefined}
        />
        <StatCard
          title="Total Runs"
          value={loading ? '...' : (stats?.total_runs ?? 0)}
          subtitle="Nightly review cycles"
          icon={Activity}
        />
        <StatCard
          title="Cases Reviewed"
          value={loading ? '...' : (stats?.total_reviewed ?? 0)}
          subtitle="All-time reviewed"
          icon={FileSearch}
        />
        <StatCard
          title="Confirmation Rate"
          value={loading ? '...' : `${confirmRate}%`}
          subtitle={`${stats?.confirmed ?? 0} of ${stats?.total_reviewed ?? 0} confirmed`}
          icon={CheckCircle}
          className={confirmRate >= 80 ? 'border-green-500/30' : confirmRate >= 50 ? 'border-yellow-500/30' : undefined}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          title="Confirmed"
          value={loading ? '...' : (stats?.confirmed ?? 0)}
          subtitle="Deductions verified on the Trading Platform"
          icon={CheckCircle}
          className="border-green-500/30"
        />
        <StatCard
          title="Needs Deduction"
          value={loading ? '...' : (stats?.pending_deduction ?? 0)}
          subtitle="Not yet applied on the Trading Platform"
          icon={AlertCircle}
          className={(stats?.pending_deduction ?? 0) > 0 ? 'border-yellow-500/30' : undefined}
        />
        <StatCard
          title="Review Errors"
          value={loading ? '...' : (stats?.errors ?? 0)}
          subtitle="Failed to verify"
          icon={XCircle}
          className={(stats?.errors ?? 0) > 0 ? 'border-red-500/30' : undefined}
        />
      </div>
    </div>
  );
}
