'use client';

import { useState, useMemo, useCallback } from 'react';
import { format } from 'date-fns';
import { SummaryCards } from '@/components/payouts/summary-cards';
import { PayoutsTable } from '@/components/payouts/payouts-table';
import { PayoutsFilters } from '@/components/payouts/payouts-filters';
import { DateRangeFilter } from '@/components/ui/date-range-filter';
import { usePayouts } from '@/hooks/use-payouts';
import { usePayoutSummary } from '@/hooks/use-payout-summary';
import type { PayoutRecord, PayoutStatus, PayoutSummary } from '@/types/payouts';
import { logAuditEntry } from '@/lib/audit/history';
import { toCsv, csvFilename, downloadCsv } from '@/lib/export';


export default function PayoutsPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [preApprovalFilter, setPreApprovalFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const [page, setPage] = useState(1);
  const perPage = 20;

  const { data, loading, error, refetch } = usePayouts({
    search: search || undefined,
    status: statusFilter || undefined,
    perPage: 500,
  });

  const { data: _apiSummary, loading: summaryLoading, refetch: refetchSummary } = usePayoutSummary();

  const records = useMemo(() => data?.data || [], [data]);

  // Local state for optimistic updates
  const [localRecords, setLocalRecords] = useState<Map<string, Partial<PayoutRecord>>>(new Map());

  const mergedRecords = useMemo(() => {
    let items = records.map((r) => {
      const local = localRecords.get(r.id);
      return local ? { ...r, ...local } : r;
    });
    if (startDate) {
      const start = new Date(startDate);
      items = items.filter((r) => !r.dateRequested || new Date(r.dateRequested) >= start);
    }
    if (endDate) {
      const end = new Date(endDate + 'T23:59:59');
      items = items.filter((r) => !r.dateRequested || new Date(r.dateRequested) <= end);
    }
    if (preApprovalFilter !== '') {
      const filterVal = Number(preApprovalFilter);
      items = items.filter((r) => {
        const status = r.preApprovedStatus ?? 0;
        return status === filterVal;
      });
    }
    return items;
  }, [records, localRecords, startDate, endDate, preApprovalFilter]);

  // Derive summary from filtered records so stats respond to date changes
  const summary = useMemo((): PayoutSummary | null => {
    if (loading && mergedRecords.length === 0) return _apiSummary;
    const items = mergedRecords;
    return {
      total: items.length,
      totalClientAmount: items.reduce((s, r) => s + (r.clientAmount || 0), 0),
      ipFlags: items.filter((r) => r.ipMismatch).length,
      investigations: items.filter((r) => r.status === 'Investigate').length,
      violationFlags: items.filter((r) => r.platformViolations && r.platformViolations.length > 0).length,
      totalDeductions: items.reduce((s, r) => s + (r.platformDeductions?.totalDeductions || 0), 0),
    };
  }, [mergedRecords, loading, _apiSummary]);

  const handleStatusChange = useCallback(async (id: string, status: PayoutStatus) => {
    const rec = records.find((r) => r.id === id);
    logAuditEntry({
      action: 'status_change',
      entityType: 'payout',
      entityId: id,
      details: `Internal status changed to ${status}`,
      previousValue: rec?.status,
      newValue: status,
      metadata: { login: rec?.login, accountId: rec?.accountId },
    });

    // Optimistic update
    setLocalRecords((prev) => new Map(prev).set(id, { status }));

    try {
      const res = await fetch(`/api/payouts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error('Failed to update status');
      refetch();
      refetchSummary();
    } catch {
      // Revert optimistic update
      setLocalRecords((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }
  }, [records, refetch, refetchSummary]);

  const handleNotesChange = useCallback(async (id: string, notes: string) => {
    const rec = records.find((r) => r.id === id);
    logAuditEntry({
      action: 'notes_update',
      entityType: 'payout',
      entityId: id,
      details: `Notes updated`,
      newValue: notes,
      metadata: { login: rec?.login, accountId: rec?.accountId },
    });

    setLocalRecords((prev) => new Map(prev).set(id, { notes }));

    try {
      const res = await fetch(`/api/payouts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes }),
      });
      if (!res.ok) throw new Error('Failed to save notes');
    } catch {
      setLocalRecords((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }
  }, [records]);

  const handlePreApproval = useCallback(async (id: string, preApprovalStatus: number, note?: string) => {
    const labels: Record<number, string> = { [-1]: 'Not Pre-Approved', 0: 'Not Reviewed', 1: 'Pre-Approved' };
    const rec = records.find((r) => r.id === id);
    const externalId = rec?._id || rec?.accountId || id;

    logAuditEntry({
      action: 'pre_approval_change',
      entityType: 'payout',
      entityId: id,
      details: `Pre-approval set to ${labels[preApprovalStatus]}`,
      previousValue: labels[rec?.preApprovedStatus ?? 0],
      newValue: labels[preApprovalStatus],
      metadata: { login: rec?.login, accountId: rec?.accountId, note },
    });

    // Optimistic update
    setLocalRecords((prev) => new Map(prev).set(id, { preApprovedStatus: preApprovalStatus }));

    try {
      const res = await fetch(`/api/payouts/${externalId}/preapprove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preapprove', status: preApprovalStatus, note: note || '' }),
      });
      if (!res.ok) throw new Error('Failed to update pre-approval');
      refetch();
    } catch {
      setLocalRecords((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }
  }, [records, refetch]);

  const handleFinalAction = useCallback(async (id: string, action: 'approve' | 'reject', note?: string) => {
    const rec = records.find((r) => r.id === id);
    const externalId = rec?._id || rec?.accountId || id;

    logAuditEntry({
      action: action === 'approve' ? 'payout_approved' : 'payout_rejected',
      entityType: 'payout',
      entityId: id,
      details: `Payout ${action === 'approve' ? 'approved (paid)' : 'rejected (not paid)'}`,
      metadata: { login: rec?.login, accountId: rec?.accountId, amount: rec?.amount, note },
    });

    try {
      const mergedRec = rec ? { ...rec, ...localRecords.get(rec.id) } : undefined;
      const res = await fetch(`/api/payouts/${externalId}/preapprove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, note: note || '', record: mergedRec }),
      });
      if (!res.ok) throw new Error(`Failed to ${action} payout`);
      // Refetch — approved/rejected payouts disappear from the provider platform pending list
      refetch();
      refetchSummary();
    } catch {
      // noop — provider call failed
    }
  }, [records, localRecords, refetch, refetchSummary]);

  const handleResetFilters = useCallback(() => {
    setSearch('');
    setStatusFilter('');
    setPreApprovalFilter('');
    setStartDate('');
    setEndDate('');
  }, []);

  const handleRefresh = useCallback(() => {
    refetch();
    refetchSummary();
  }, [refetch, refetchSummary]);

  const handleExport = useCallback(() => {
    const exportRecords = mergedRecords;
    if (exportRecords.length === 0) return;

    const preApprovalLabel = (r: PayoutRecord) =>
      r.preApprovedStatus === 1 ? 'Pre-Approved' : r.preApprovedStatus === -1 ? 'Not Pre-Approved' : 'Not Reviewed';

    const csv = toCsv(exportRecords, [
      { header: 'Date', value: (r) => (r.dateRequested ? format(new Date(r.dateRequested), 'MM/dd/yyyy') : '') },
      { header: 'Order#', value: (r) => r.orderNumber || '' },
      { header: 'Login', value: (r) => r.login || '' },
      { header: 'Account', value: (r) => r.accountId || '' },
      { header: 'Amount', value: (r) => (r.amount || 0).toFixed(2) },
      { header: 'Client Amount', value: (r) => (r.clientAmount || 0).toFixed(2) },
      { header: 'Email', value: (r) => r.email || '' },
      { header: 'Country', value: (r) => r.kycCountry || '' },
      { header: 'KYC', value: (r) => r.kycStatus || '' },
      { header: 'Pre-Approval', value: preApprovalLabel },
      { header: 'IP Mismatch', value: (r) => (r.ipMismatch ? 'Yes' : 'No') },
      { header: 'Violations', value: (r) => r.platformViolations?.join('; ') || '' },
      { header: 'Status', value: (r) => r.status || '' },
      { header: 'Notes', value: (r) => r.notes || '' },
    ]);
    downloadCsv(csvFilename('risk_payouts'), csv);
  }, [mergedRecords]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold bg-gradient-to-r from-red-400 to-orange-400 bg-clip-text text-transparent">
          Pending Payouts
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Review pending payouts awaiting approval. Track IP variances, Trading Platform risk checks, and KYC status.
        </p>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Summary Cards */}
      <SummaryCards summary={summary} loading={summaryLoading} />

      {/* Filters */}
      <PayoutsFilters
        search={search}
        onSearchChange={setSearch}
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
        preApprovalFilter={preApprovalFilter}
        onPreApprovalChange={setPreApprovalFilter}
        onRefresh={handleRefresh}
        onExport={handleExport}
        onReset={handleResetFilters}
        loading={loading}
      />
      <div className="flex items-center gap-3 -mt-3">
        <DateRangeFilter startDate={startDate} endDate={endDate} onStartChange={setStartDate} onEndChange={setEndDate} />
      </div>

      {/* Table — paginated client-side with expandable rows */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
        <PayoutsTable
          records={mergedRecords.slice((page - 1) * perPage, page * perPage)}
          loading={loading}
          onStatusChange={handleStatusChange}
          onNotesChange={handleNotesChange}
          onPreApproval={handlePreApproval}
          onFinalAction={handleFinalAction}
        />
      </div>

      {/* Pagination */}
      {mergedRecords.length > perPage && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-500">
            Page {page} of {Math.ceil(mergedRecords.length / perPage)} ({mergedRecords.length} total)
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
              onClick={() => setPage(Math.min(Math.ceil(mergedRecords.length / perPage), page + 1))}
              disabled={page >= Math.ceil(mergedRecords.length / perPage)}
              className="px-3 py-1 text-xs rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30"
            >
              Next
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
