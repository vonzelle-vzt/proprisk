'use client';

import { EnforcementQueueSummary } from '@/types/enforcement';
import { StatCard } from '@/components/ui/stat-card';
import { Shield, AlertTriangle, DollarSign, Clock, CheckCircle, AlertCircle, XCircle } from 'lucide-react';

interface EnforcementStatsProps {
  summary: EnforcementQueueSummary | null;
  loading?: boolean;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'N/A';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  if (diffMs < 0) return 'N/A';

  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function EnforcementStats({ summary, loading }: EnforcementStatsProps) {
  const criticalCount = summary?.by_escalation?.critical ?? 0;
  const reviewerStats = summary?.by_reviewer_status ?? {};
  const confirmedCount = reviewerStats['deduction_confirmed'] ?? 0;
  const needsDeductionCount = reviewerStats['pending_deduction'] ?? 0;
  const reviewErrorCount = reviewerStats['review_error'] ?? 0;
  const hasReviewerData = confirmedCount > 0 || needsDeductionCount > 0 || reviewErrorCount > 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          title="Total Pending"
          value={loading ? '...' : (summary?.total_pending ?? 0)}
          subtitle="Awaiting review"
          icon={Shield}
        />
        <StatCard
          title="Critical Items"
          value={loading ? '...' : criticalCount}
          subtitle="Require immediate action"
          icon={AlertTriangle}
          className={criticalCount > 0 ? 'border-red-500/50 shadow-red-500/10' : undefined}
        />
        <StatCard
          title="Total Recommended"
          value={loading ? '...' : formatCurrency(summary?.total_recommended_amount ?? 0)}
          subtitle="Pending enforcement value"
          icon={DollarSign}
        />
        <StatCard
          title="Oldest Pending"
          value={loading ? '...' : formatRelativeTime(summary?.oldest_pending_at ?? null)}
          subtitle="Time in queue"
          icon={Clock}
        />
      </div>
      {hasReviewerData && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatCard
            title="Confirmed"
            value={loading ? '...' : confirmedCount}
            subtitle="Deductions verified on the Trading Platform"
            icon={CheckCircle}
            className="border-green-500/30"
          />
          <StatCard
            title="Needs Deduction"
            value={loading ? '...' : needsDeductionCount}
            subtitle="Not yet applied on the Trading Platform"
            icon={AlertCircle}
            className={needsDeductionCount > 0 ? 'border-yellow-500/30' : undefined}
          />
          <StatCard
            title="Review Errors"
            value={loading ? '...' : reviewErrorCount}
            subtitle="Failed to verify"
            icon={XCircle}
            className={reviewErrorCount > 0 ? 'border-red-500/30' : undefined}
          />
        </div>
      )}
    </div>
  );
}
