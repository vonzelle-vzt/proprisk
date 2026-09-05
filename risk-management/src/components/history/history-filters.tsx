'use client';

import { Download, RefreshCw, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { Select } from '@/components/ui/select';

interface Props {
  search: string;
  onSearchChange: (v: string) => void;
  decisionFilter: string;
  onDecisionChange: (v: string) => void;
  onRefresh: () => void;
  onExport: () => void;
  onReset: () => void;
  loading?: boolean;
}

export function HistoryFilters({
  search,
  onSearchChange,
  decisionFilter,
  onDecisionChange,
  onRefresh,
  onExport,
  onReset,
  loading,
}: Props) {
  const hasFilters = search || decisionFilter;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-1 items-center gap-3">
        <SearchInput
          value={search}
          onChange={onSearchChange}
          placeholder="Search login, email, name..."
          className="max-w-sm"
        />
        <Select
          value={decisionFilter}
          onChange={onDecisionChange}
          options={[
            { value: '', label: 'All Decisions' },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' },
          ]}
        />
        {hasFilters && (
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
