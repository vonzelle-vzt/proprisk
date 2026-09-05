'use client';

import { DataTable } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';

export interface ReviewedCase {
  id: string;
  account_id: string;
  violation_type: string;
  action_type: string;
  recommended_amount: number;
  status: string;
  reviewer_status: string;
  reviewer_notes: string | null;
  reviewed_at: string | null;
  created_at: string;
  severity_score: number;
  escalation_level: string;
  recommendation_details: {
    login?: string;
    plan?: string;
    source?: string;
    starting_balance?: number;
    flagged_trade_count?: number;
    base_amount?: number;
    repeat_multiplier?: number;
    severity_factors?: string[];
    account_context?: { plan: string; balance: number; total_prior_deductions: number };
  } | null;
  recommendation_reason: string | null;
  prior_violation_count: number;
  repeat_multiplier: number;
  decided_by: string | null;
  decided_at: string | null;
  execution_result: Record<string, unknown> | null;
}

interface ReviewerCaseTableProps {
  cases: ReviewedCase[];
  onRowClick?: (c: ReviewedCase) => void;
}

const violationBadgeVariant: Record<string, 'purple' | 'red' | 'yellow' | 'blue' | 'green' | 'silver'> = {
  copy: 'purple',
  martingale: 'red',
  grid: 'yellow',
  hft: 'blue',
  news: 'green',
};

function getViolationVariant(type: string) {
  return violationBadgeVariant[type] ?? 'silver';
}

function getReviewerVariant(status: string): 'green' | 'yellow' | 'red' | 'silver' {
  switch (status) {
    case 'deduction_confirmed': return 'green';
    case 'pending_deduction': return 'yellow';
    case 'review_error': return 'red';
    default: return 'silver';
  }
}

function getReviewerLabel(status: string): string {
  switch (status) {
    case 'deduction_confirmed': return 'Confirmed';
    case 'pending_deduction': return 'Needs Deduction';
    case 'review_error': return 'Error';
    default: return status;
  }
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
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

export function ReviewerCaseTable({ cases, onRowClick }: ReviewerCaseTableProps) {
  const columns = [
    {
      key: 'account_id',
      header: 'Account',
      render: (c: ReviewedCase) => (
        <span className="font-mono text-[11px] text-gray-200">
          {c.account_id.length > 12
            ? `${c.account_id.slice(0, 6)}...${c.account_id.slice(-4)}`
            : c.account_id}
        </span>
      ),
    },
    {
      key: 'login',
      header: 'Login',
      render: (c: ReviewedCase) => {
        const login = c.recommendation_details?.login;
        return (
          <span className="font-mono text-[11px] text-gray-300">
            {login || '—'}
          </span>
        );
      },
    },
    {
      key: 'violation_type',
      header: 'Violation',
      render: (c: ReviewedCase) => (
        <Badge variant={getViolationVariant(c.violation_type)}>
          {c.violation_type}
        </Badge>
      ),
    },
    {
      key: 'recommended_amount',
      header: 'Amount',
      render: (c: ReviewedCase) => (
        <span className="font-mono text-[11px] text-white">
          {formatCurrency(c.recommended_amount)}
        </span>
      ),
    },
    {
      key: 'reviewer_status',
      header: 'Result',
      render: (c: ReviewedCase) => (
        <Badge variant={getReviewerVariant(c.reviewer_status)}>
          {getReviewerLabel(c.reviewer_status)}
        </Badge>
      ),
    },
    {
      key: 'status',
      header: 'Enforcement',
      render: (c: ReviewedCase) => (
        <Badge variant={c.status === 'executed' ? 'green' : c.status === 'approved' ? 'blue' : 'silver'}>
          {c.status}
        </Badge>
      ),
    },
    {
      key: 'reviewed_at',
      header: 'Reviewed',
      render: (c: ReviewedCase) => (
        <span className="text-gray-400 text-[11px]">
          {formatDateTime(c.reviewed_at)}
        </span>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={cases}
      onRowClick={onRowClick}
      emptyMessage="No reviewed cases yet"
    />
  );
}
