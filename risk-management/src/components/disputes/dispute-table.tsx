'use client';

import type { Dispute, DisputeStatus } from '@/lib/disputes/types';
import { DataTable } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { formatRelative } from '@/lib/utils/format';

interface DisputeTableProps {
  items: Dispute[];
  onRowClick: (item: Dispute) => void;
}

const STATUS_VARIANT: Record<DisputeStatus, 'default' | 'red' | 'green' | 'yellow' | 'blue' | 'purple' | 'silver'> = {
  open: 'blue',
  under_review: 'yellow',
  upheld: 'silver',
  overturned: 'green',
  withdrawn: 'default',
};

const STATUS_LABEL: Record<DisputeStatus, string> = {
  open: 'Open',
  under_review: 'Under Review',
  upheld: 'Upheld',
  overturned: 'Overturned',
  withdrawn: 'Withdrawn',
};

const SUBJECT_LABEL: Record<Dispute['subjectType'], string> = {
  breach: 'Breach',
  payout: 'Payout',
  deduction: 'Deduction',
};

export function DisputeTable({ items, onRowClick }: DisputeTableProps) {
  const columns = [
    {
      key: 'subject_type',
      header: 'Subject',
      render: (item: Dispute) => (
        <div className="flex flex-col">
          <Badge variant="default">{SUBJECT_LABEL[item.subjectType]}</Badge>
          <span className="mt-0.5 font-mono text-[10px] text-gray-500">{item.subjectId}</span>
        </div>
      ),
    },
    {
      key: 'account_id',
      header: 'Account',
      render: (item: Dispute) => (
        <span className="font-mono text-[11px] text-gray-200">{item.accountId ?? '—'}</span>
      ),
    },
    {
      key: 'raised_by',
      header: 'Raised By',
      render: (item: Dispute) => <span className="text-[11px] text-gray-200">{item.raisedBy}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (item: Dispute) => <Badge variant={STATUS_VARIANT[item.status]}>{STATUS_LABEL[item.status]}</Badge>,
    },
    {
      key: 'evidence_pack_id',
      header: 'Evidence',
      render: (item: Dispute) =>
        item.evidencePackId ? (
          <Badge variant="silver">Attached</Badge>
        ) : (
          <Badge variant="red">Missing</Badge>
        ),
    },
    {
      key: 'created_at',
      header: 'Opened',
      render: (item: Dispute) => <span className="text-gray-400 text-[11px]">{formatRelative(item.raisedAt)}</span>,
    },
    {
      key: 'resolved_at',
      header: 'Resolved',
      render: (item: Dispute) => (
        <span className="text-gray-400 text-[11px]">
          {item.resolvedAt ? formatRelative(item.resolvedAt) : '—'}
        </span>
      ),
    },
  ];

  return <DataTable columns={columns} data={items} onRowClick={onRowClick} emptyMessage="No disputes on record" />;
}
