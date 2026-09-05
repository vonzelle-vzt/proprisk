'use client';

import { Download, RefreshCw, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { Select } from '@/components/ui/select';

interface PayoutsFiltersProps {
  search: string;
  onSearchChange: (v: string) => void;
  statusFilter: string;
  onStatusChange: (v: string) => void;
  preApprovalFilter?: string;
  onPreApprovalChange?: (v: string) => void;
  onRefresh: () => void;
  onExport: () => void;
  onReset?: () => void;
  loading?: boolean;
}

export function PayoutsFilters({
  search,
  onSearchChange,
  statusFilter,
  onStatusChange,
  preApprovalFilter,
  onPreApprovalChange,
  onRefresh,
  onExport,
  onReset,
  loading,
}: PayoutsFiltersProps) {
  const hasFilters = search || statusFilter || (preApprovalFilter && preApprovalFilter !== '');

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-1 items-center gap-3">
        <SearchInput
          value={search}
          onChange={onSearchChange}
          placeholder="Search order, account, email, login..."
          className="max-w-sm"
        />
        <Select
          value={statusFilter}
          onChange={onStatusChange}
          options={[
            { value: '', label: 'All Statuses' },
            { value: 'Pending', label: 'Pending' },
            { value: 'Investigate', label: 'Investigate' },
            { value: 'Cleared', label: 'Cleared' },
            { value: 'Rejected', label: 'Rejected' },
            { value: 'Banned', label: 'Banned' },
          ]}
        />
        {onPreApprovalChange && (
          <Select
            value={preApprovalFilter || ''}
            onChange={onPreApprovalChange}
            options={[
              { value: '', label: 'All Pre-Approval' },
              { value: '1', label: 'Pre-Approved' },
              { value: '0', label: 'Not Reviewed' },
              { value: '-1', label: 'Not Pre-Approved' },
            ]}
          />
        )}
        {hasFilters && onReset && (
          <Button variant="ghost" size="sm" onClick={onReset} className="!text-gray-500 hover:!text-gray-300">
            <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reset
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
        <Button variant="secondary" size="sm" onClick={onExport}>
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>
    </div>
  );
}
