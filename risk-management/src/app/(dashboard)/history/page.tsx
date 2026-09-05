'use client';

import { useState, useCallback, useMemo } from 'react';
import { format } from 'date-fns';
import { HistorySummaryCards } from '@/components/history/history-summary-cards';
import { HistoryFilters } from '@/components/history/history-filters';
import { HistoryTable } from '@/components/history/history-table';
import { HistoryDetailModal } from '@/components/history/history-detail-modal';
import { DateRangeFilter } from '@/components/ui/date-range-filter';
import { usePayoutHistory, usePayoutHistorySummary } from '@/hooks/use-payout-history';
import { formatCurrency } from '@/lib/utils/format';
import { toCsv, csvFilename, downloadCsv } from '@/lib/export';
import type { PayoutHistoryRecord } from '@/types/history';

export default function HistoryPage() {
  const [search, setSearch] = useState('');
  const [decisionFilter, setDecisionFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(1);
  const perPage = 20;
  const [selectedRecord, setSelectedRecord] = useState<PayoutHistoryRecord | null>(null);

  const { data, loading, error, refetch } = usePayoutHistory({
    search: search || undefined,
    decision: decisionFilter || undefined,
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    page,
    perPage,
  });

  const { data: summary, loading: summaryLoading, refetch: refetchSummary } = usePayoutHistorySummary(
    startDate || undefined,
    endDate || undefined
  );

  const records = useMemo(() => data?.data || [], [data?.data]);
  const meta = data?.meta;

  const handleResetFilters = useCallback(() => {
    setSearch('');
    setDecisionFilter('');
    setStartDate('');
    setEndDate('');
    setPage(1);
  }, []);

  const handleRefresh = useCallback(() => {
    refetch();
    refetchSummary();
  }, [refetch, refetchSummary]);

  const handleExport = useCallback(() => {
    if (records.length === 0) return;

    const csv = toCsv(records, [
      { header: 'Date Decided', value: (r) => (r.decidedAt ? format(new Date(r.decidedAt), 'MM/dd/yyyy HH:mm') : '') },
      { header: 'Login', value: (r) => r.login || '' },
      { header: 'Name', value: (r) => (r.firstName && r.lastName ? `${r.firstName} ${r.lastName}` : '') },
      { header: 'Email', value: (r) => r.email || '' },
      { header: 'Account', value: (r) => r.platformAccountId || '' },
      { header: 'Plan', value: (r) => r.plan || '' },
      { header: 'Amount', value: (r) => (r.amount || 0).toFixed(2) },
      { header: 'Client Amount', value: (r) => (r.clientAmount || 0).toFixed(2) },
      { header: 'Decision', value: (r) => r.decision },
      { header: 'Violations', value: (r) => r.violationsList.join('; ') },
      { header: 'Deductions', value: (r) => (r.deductionsTotal || 0).toFixed(2) },
      { header: 'Decided By', value: (r) => r.decidedBy || '' },
      { header: 'Notes', value: (r) => r.decisionNotes || '' },
    ]);
    downloadCsv(csvFilename('payout_history'), csv);
  }, [records]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold bg-gradient-to-r from-red-400 to-orange-400 bg-clip-text text-transparent">
          Payout History
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Track record of all payout decisions. Full risk snapshot preserved at decision time.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-400">
          Error: {error}
        </div>
      )}

      <HistorySummaryCards summary={summary} loading={summaryLoading} />

      <HistoryFilters
        search={search}
        onSearchChange={(v) => { setSearch(v); setPage(1); }}
        decisionFilter={decisionFilter}
        onDecisionChange={(v) => { setDecisionFilter(v); setPage(1); }}
        onRefresh={handleRefresh}
        onExport={handleExport}
        onReset={handleResetFilters}
        loading={loading}
      />
      <div className="flex items-center gap-3 -mt-3">
        <DateRangeFilter startDate={startDate} endDate={endDate} onStartChange={(v) => { setStartDate(v); setPage(1); }} onEndChange={(v) => { setEndDate(v); setPage(1); }} />
      </div>

      <HistoryTable
        records={records}
        onRowClick={setSelectedRecord}
        loading={loading}
      />

      {meta && meta.total_pages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-500">
            Page {meta.page} of {meta.total_pages} ({meta.total} total)
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page === 1}
              className="px-3 py-1 text-xs rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(Math.min(meta.total_pages, page + 1))}
              disabled={page >= meta.total_pages}
              className="px-3 py-1 text-xs rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30"
            >
              Next
            </button>
          </div>
        </div>
      )}

      <HistoryDetailModal
        record={selectedRecord}
        isOpen={!!selectedRecord}
        onClose={() => setSelectedRecord(null)}
      />
    </div>
  );
}
