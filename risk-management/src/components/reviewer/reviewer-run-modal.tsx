'use client';

import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ReviewerRun } from './reviewer-run-table';

interface ReviewerRunModalProps {
  run: ReviewerRun | null;
  isOpen: boolean;
  onClose: () => void;
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
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
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

export function ReviewerRunModal({ run, isOpen, onClose }: ReviewerRunModalProps) {
  if (!run) return null;

  const total = run.confirmed + run.pending_deduction + run.errors;
  const confirmPct = total > 0 ? Math.round((run.confirmed / total) * 100) : 0;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Run Detail" size="lg">
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3 flex-wrap">
          <Badge variant={getStatusVariant(run.status)}>
            {run.status}
          </Badge>
          <Badge variant={run.platform_healthy ? 'green' : 'red'}>
            Trading Platform {run.platform_healthy ? 'Healthy' : 'Down'}
          </Badge>
          <span className="text-xs text-gray-500 font-mono">{run.id.slice(0, 8)}</span>
        </div>

        {/* Timing */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <span className="text-[10px] text-gray-500 block">Started</span>
            <span className="text-xs text-white">{formatDateTime(run.started_at)}</span>
          </div>
          <div>
            <span className="text-[10px] text-gray-500 block">Completed</span>
            <span className="text-xs text-white">{formatDateTime(run.completed_at)}</span>
          </div>
          <div>
            <span className="text-[10px] text-gray-500 block">Duration</span>
            <span className="text-xs text-white">{formatDuration(run.started_at, run.completed_at)}</span>
          </div>
        </div>

        {/* Results Breakdown */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
          <h4 className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-3">
            Results Breakdown
          </h4>
          <div className="grid grid-cols-4 gap-3 mb-3">
            <div className="text-center">
              <span className="text-lg font-bold text-white block">{run.total_cases}</span>
              <span className="text-[10px] text-gray-500">Total Cases</span>
            </div>
            <div className="text-center">
              <span className="text-lg font-bold text-emerald-400 block">{run.confirmed}</span>
              <span className="text-[10px] text-gray-500">Confirmed</span>
            </div>
            <div className="text-center">
              <span className={`text-lg font-bold block ${run.pending_deduction > 0 ? 'text-yellow-400' : 'text-gray-500'}`}>
                {run.pending_deduction}
              </span>
              <span className="text-[10px] text-gray-500">Needs Deduction</span>
            </div>
            <div className="text-center">
              <span className={`text-lg font-bold block ${run.errors > 0 ? 'text-red-400' : 'text-gray-500'}`}>
                {run.errors}
              </span>
              <span className="text-[10px] text-gray-500">Errors</span>
            </div>
          </div>

          {/* Confirmation Rate Bar */}
          {total > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-gray-400">Confirmation Rate</span>
                <span className="text-[11px] font-bold text-white">{confirmPct}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{ width: `${confirmPct}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Error Details */}
        {run.error_details && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3">
            <h4 className="text-[10px] font-medium uppercase tracking-wider text-red-400 mb-2">
              Error Details
            </h4>
            <pre className="text-[11px] text-gray-300 whitespace-pre-wrap font-mono bg-black/30 rounded-lg p-2 max-h-40 overflow-y-auto">
              {JSON.stringify(run.error_details, null, 2)}
            </pre>
          </div>
        )}

        {/* Timestamps */}
        <div className="flex items-center gap-6 text-[11px] text-gray-500 border-t border-white/10 pt-3">
          <span>Run ID: {run.id}</span>
          <span>Created: {formatDateTime(run.created_at)}</span>
        </div>

        {/* Close */}
        <div className="flex items-center justify-end pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
