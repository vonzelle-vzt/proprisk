'use client';

import { EnforcementRecommendation } from '@/types/enforcement';
import { DataTable } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Check, X } from 'lucide-react';

interface EnforcementTableProps {
  items: EnforcementRecommendation[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onRowClick: (item: EnforcementRecommendation) => void;
  selectedIds: string[];
  onToggleSelect: (id: string) => void;
  actionLoadingId?: string | null;
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

function getSeverityColor(score: number): string {
  if (score >= 70) return 'text-red-400';
  if (score >= 50) return 'text-yellow-400';
  if (score >= 25) return 'text-blue-400';
  return 'text-gray-400';
}

function getEscalationVariant(level: string): 'red' | 'yellow' | 'blue' | 'silver' {
  switch (level) {
    case 'critical': return 'red';
    case 'urgent': return 'yellow';
    case 'elevated': return 'blue';
    default: return 'silver';
  }
}

function formatRelativeTime(dateStr: string): string {
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

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function EnforcementTable({
  items,
  onApprove,
  onReject,
  onRowClick,
  selectedIds,
  onToggleSelect,
  actionLoadingId,
}: EnforcementTableProps) {
  const columns = [
    {
      key: 'select',
      header: '',
      className: 'w-8',
      render: (item: EnforcementRecommendation) => (
        <input
          type="checkbox"
          checked={selectedIds.includes(item.id)}
          onChange={(e) => {
            e.stopPropagation();
            onToggleSelect(item.id);
          }}
          onClick={(e) => e.stopPropagation()}
          className="h-3.5 w-3.5 rounded border-white/20 bg-white/5 accent-red-500"
        />
      ),
    },
    {
      key: 'account_id',
      header: 'Account',
      render: (item: EnforcementRecommendation) => (
        <span className="font-mono text-[11px] text-gray-200">
          {item.account_id.length > 12
            ? `${item.account_id.slice(0, 6)}...${item.account_id.slice(-4)}`
            : item.account_id}
        </span>
      ),
    },
    {
      key: 'violation_type',
      header: 'Type',
      render: (item: EnforcementRecommendation) => (
        <Badge variant={getViolationVariant(item.violation_type)}>
          {item.violation_type}
        </Badge>
      ),
    },
    {
      key: 'action_type',
      header: 'Action',
      render: (item: EnforcementRecommendation) => (
        <Badge variant="default">{item.action_type.replace('_', ' ')}</Badge>
      ),
    },
    {
      key: 'recommended_amount',
      header: 'Amount',
      render: (item: EnforcementRecommendation) => (
        <span className="font-mono text-[11px] text-white">
          {formatCurrency(item.recommended_amount)}
        </span>
      ),
    },
    {
      key: 'severity_score',
      header: 'Severity',
      render: (item: EnforcementRecommendation) => (
        <span className={`font-bold text-[11px] ${getSeverityColor(item.severity_score)}`}>
          {item.severity_score}
        </span>
      ),
    },
    {
      key: 'escalation_level',
      header: 'Escalation',
      render: (item: EnforcementRecommendation) => (
        <Badge variant={getEscalationVariant(item.escalation_level)}>
          {item.escalation_level}
        </Badge>
      ),
    },
    {
      key: 'reviewer_status',
      header: 'Review',
      render: (item: EnforcementRecommendation) => {
        const status = item.reviewer_status;
        if (!status) return <Badge variant="silver">Not Reviewed</Badge>;
        switch (status) {
          case 'deduction_confirmed':
            return <Badge variant="green">Confirmed</Badge>;
          case 'pending_deduction':
            return <Badge variant="yellow">Needs Deduction</Badge>;
          case 'review_error':
            return <Badge variant="red">Error</Badge>;
          default:
            return <Badge variant="silver">{status}</Badge>;
        }
      },
    },
    {
      key: 'created_at',
      header: 'Created',
      render: (item: EnforcementRecommendation) => (
        <span className="text-gray-400 text-[11px]">
          {formatRelativeTime(item.created_at)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (item: EnforcementRecommendation) => {
        const isPending = item.status === 'pending';
        const isLoading = actionLoadingId === item.id;
        return (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Button
              variant="success"
              size="sm"
              className="px-2 py-1 text-[10px]"
              onClick={() => onApprove(item.id)}
              disabled={!isPending || isLoading}
              loading={isLoading}
            >
              <Check className="h-3 w-3" />
            </Button>
            <Button
              variant="danger"
              size="sm"
              className="px-2 py-1 text-[10px]"
              onClick={() => onReject(item.id)}
              disabled={!isPending || isLoading}
              loading={isLoading}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={items}
      onRowClick={onRowClick}
      emptyMessage="No enforcement items in queue"
    />
  );
}
