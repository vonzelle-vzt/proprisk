'use client';

import { DataTable } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';

export interface ReviewerRun {
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
  error_details: Record<string, unknown> | null;
  created_at: string;
}

interface ReviewerRunTableProps {
  runs: ReviewerRun[];
  onRowClick?: (run: ReviewerRun) => void;
}

function getStatusVariant(status: string): 'green' | 'red' | 'yellow' | 'blue' | 'silver' {
  switch (status) {
    case 'completed': return 'green';
    case 'failed': return 'red';
    case 'deferred': return 'yellow';
    case 'running': return 'blue';
    default: return 'silver';
  }
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function ReviewerRunTable({ runs, onRowClick }: ReviewerRunTableProps) {
  const columns = [
    {
      key: 'created_at',
      header: 'Run Date',
      render: (run: ReviewerRun) => (
        <span className="text-gray-200 text-[11px]">
          {formatDateTime(run.created_at)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (run: ReviewerRun) => (
        <Badge variant={getStatusVariant(run.status)}>
          {run.status}
        </Badge>
      ),
    },
    {
      key: 'platform_healthy',
      header: 'Trading Platform',
      render: (run: ReviewerRun) => (
        <Badge variant={run.platform_healthy ? 'green' : 'red'}>
          {run.platform_healthy ? 'Healthy' : 'Down'}
        </Badge>
      ),
    },
    {
      key: 'total_cases',
      header: 'Cases',
      render: (run: ReviewerRun) => (
        <span className="font-mono text-[11px] text-white">{run.total_cases}</span>
      ),
    },
    {
      key: 'confirmed',
      header: 'Confirmed',
      render: (run: ReviewerRun) => (
        <span className="font-mono text-[11px] text-emerald-400">{run.confirmed}</span>
      ),
    },
    {
      key: 'pending_deduction',
      header: 'Needs Deduction',
      render: (run: ReviewerRun) => (
        <span className={`font-mono text-[11px] ${run.pending_deduction > 0 ? 'text-yellow-400' : 'text-gray-500'}`}>
          {run.pending_deduction}
        </span>
      ),
    },
    {
      key: 'errors',
      header: 'Errors',
      render: (run: ReviewerRun) => (
        <span className={`font-mono text-[11px] ${run.errors > 0 ? 'text-red-400' : 'text-gray-500'}`}>
          {run.errors}
        </span>
      ),
    },
    {
      key: 'duration',
      header: 'Duration',
      render: (run: ReviewerRun) => (
        <span className="text-gray-400 text-[11px]">
          {formatDuration(run.started_at, run.completed_at)}
        </span>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={runs}
      onRowClick={onRowClick}
      emptyMessage="No reviewer runs recorded yet"
    />
  );
}
