'use client';

import { useEffect, useState, useCallback } from 'react';
import { EnforcementRecommendation, EnforcementQueueSummary } from '@/types/enforcement';
import { EnforcementStats } from '@/components/enforcement/enforcement-stats';
import { EnforcementTable } from '@/components/enforcement/enforcement-table';
import { EnforcementDetailModal } from '@/components/enforcement/enforcement-detail-modal';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { GlassCard } from '@/components/ui/glass-card';
import { Shield } from 'lucide-react';
import { useAssetClass } from '@/components/layout/provider-context';

const statusOptions = [
  { value: '', label: 'All Statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'executed', label: 'Executed' },
  { value: 'expired', label: 'Expired' },
];

const escalationOptions = [
  { value: '', label: 'All Escalations' },
  { value: 'normal', label: 'Normal' },
  { value: 'elevated', label: 'Elevated' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'critical', label: 'Critical' },
];

const violationTypeOptions = [
  { value: '', label: 'All Types' },
  { value: 'copy', label: 'Copy Trading' },
  { value: 'martingale', label: 'Martingale' },
  { value: 'grid', label: 'Grid Trading' },
  { value: 'hft', label: 'HFT' },
  { value: 'news', label: 'News Trading' },
  { value: 'overleveraging', label: 'Overleveraging' },
  { value: 'overnight', label: 'Overnight' },
  { value: 'profit_cap', label: 'Profit Cap' },
];

const reviewerStatusOptions = [
  { value: '', label: 'All Reviews' },
  { value: 'deduction_confirmed', label: 'Confirmed' },
  { value: 'pending_deduction', label: 'Needs Deduction' },
  { value: 'review_error', label: 'Review Error' },
  { value: 'not_reviewed', label: 'Not Reviewed' },
];

export default function EnforcementPage() {
  const assetClass = useAssetClass();
  const [items, setItems] = useState<EnforcementRecommendation[]>([]);
  const [summary, setSummary] = useState<EnforcementQueueSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [detailItem, setDetailItem] = useState<EnforcementRecommendation | null>(null);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [escalationFilter, setEscalationFilter] = useState('');
  const [violationTypeFilter, setViolationTypeFilter] = useState('');
  const [reviewerFilter, setReviewerFilter] = useState('');

  const [fetchError, setFetchError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setFetchError(null);
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (escalationFilter) params.set('escalation_level', escalationFilter);
      if (violationTypeFilter) params.set('violation_type', violationTypeFilter);
      params.set('assetClass', assetClass);

      const queueUrl = `/api/enforcement/queue?${params.toString()}`;
      const [queueRes, summaryRes] = await Promise.all([
        fetch(queueUrl, { cache: 'no-store' }),
        fetch(`/api/enforcement/summary?assetClass=${assetClass}`, { cache: 'no-store' }),
      ]);

      if (queueRes.ok) {
        const data = await queueRes.json();
        let queueItems = data.data ?? data ?? [];
        // Client-side filter for reviewer status (not a server-side param)
        if (reviewerFilter === 'not_reviewed') {
          queueItems = queueItems.filter((i: any) => !i.reviewer_status);
        } else if (reviewerFilter) {
          queueItems = queueItems.filter((i: any) => i.reviewer_status === reviewerFilter);
        }
        setItems(queueItems);
      } else {
        setFetchError(`Queue API returned ${queueRes.status}: ${await queueRes.text()}`);
      }
      if (summaryRes.ok) {
        const data = await summaryRes.json();
        setSummary(data.data ?? data ?? null);
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error('Failed to fetch enforcement data:', msg);
      setFetchError(msg);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, escalationFilter, violationTypeFilter, reviewerFilter, assetClass]);

  // Clear stale rows on asset-class switch so the table shows a loading state.
  useEffect(() => { setItems([]); setSummary(null); setLoading(true); }, [assetClass]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Clear success/error messages after a delay
  useEffect(() => {
    if (actionSuccess) {
      const t = setTimeout(() => setActionSuccess(null), 3000);
      return () => clearTimeout(t);
    }
  }, [actionSuccess]);

  useEffect(() => {
    if (actionError) {
      const t = setTimeout(() => setActionError(null), 5000);
      return () => clearTimeout(t);
    }
  }, [actionError]);

  const handleDecision = async (id: string, decision: 'approved' | 'rejected') => {
    setActionLoading(id);
    setActionError(null);
    try {
      const res = await fetch(`/api/enforcement/queue/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, decided_by: 'dashboard_user' }),
        cache: 'no-store',
      });
      if (res.ok) {
        setDetailItem(null);
        setActionSuccess(`Recommendation ${decision} successfully`);
      } else {
        const errData = await res.json().catch(() => ({}));
        setActionError(errData.error || `Failed to ${decision} — server returned ${res.status}`);
      }
    } catch (err: any) {
      setActionError(`Failed to ${decision}: ${err?.message || 'Network error'}`);
    } finally {
      setActionLoading(null);
      await fetchData();
    }
  };

  const handleBatchDecision = async (decision: 'approved' | 'rejected') => {
    if (selectedIds.length === 0) return;
    setBatchLoading(true);
    setActionError(null);
    try {
      const res = await fetch('/api/enforcement/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recommendation_ids: selectedIds,
          decision,
          decided_by: 'dashboard_user',
        }),
        cache: 'no-store',
      });
      if (res.ok) {
        const result = await res.json();
        const data = result.data || {};
        setSelectedIds([]);
        setActionSuccess(`Batch ${decision}: ${data.approved || 0} approved, ${data.rejected || 0} rejected, ${data.failed || 0} failed`);
      } else {
        const errData = await res.json().catch(() => ({}));
        setActionError(errData.error || `Batch ${decision} failed — server returned ${res.status}`);
      }
    } catch (err: any) {
      setActionError(`Batch ${decision} failed: ${err?.message || 'Network error'}`);
    } finally {
      setBatchLoading(false);
      setSelectedIds([]);
      await fetchData();
    }
  };

  const handleApprove = (id: string) => handleDecision(id, 'approved');
  const handleReject = (id: string) => handleDecision(id, 'rejected');

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  return (
    <div className="space-y-5">
      {/* Page Header */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center h-10 w-10 rounded-xl bg-red-600/20 border border-red-500/30">
          <Shield className="h-5 w-5 text-red-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Enforcement Queue</h1>
          <p className="text-xs text-gray-500">Review and approve violation enforcement actions</p>
        </div>
      </div>

      {/* Error Banner */}
      {fetchError && (
        <div className="rounded-lg border border-red-500/50 bg-red-900/30 px-4 py-2 text-xs text-red-300">
          {fetchError}
        </div>
      )}

      {/* Action Error Banner */}
      {actionError && (
        <div className="rounded-lg border border-red-500/50 bg-red-900/30 px-4 py-2 text-xs text-red-300 flex items-center justify-between">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="text-red-400 hover:text-red-200 ml-2">&times;</button>
        </div>
      )}

      {/* Action Success Banner */}
      {actionSuccess && (
        <div className="rounded-lg border border-emerald-500/50 bg-emerald-900/30 px-4 py-2 text-xs text-emerald-300 flex items-center justify-between">
          <span>{actionSuccess}</span>
          <button onClick={() => setActionSuccess(null)} className="text-emerald-400 hover:text-emerald-200 ml-2">&times;</button>
        </div>
      )}

      {/* Stats Row — override total_pending with actual queue count when showing pending */}
      <EnforcementStats
        summary={summary && statusFilter === 'pending' ? { ...summary, total_pending: items.length } : summary}
        loading={loading}
      />

      {/* Filter Bar */}
      <GlassCard padding="sm">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={statusFilter}
            onChange={setStatusFilter}
            options={statusOptions}
          />
          <Select
            value={escalationFilter}
            onChange={setEscalationFilter}
            options={escalationOptions}
          />
          <Select
            value={violationTypeFilter}
            onChange={setViolationTypeFilter}
            options={violationTypeOptions}
          />
          <Select
            value={reviewerFilter}
            onChange={setReviewerFilter}
            options={reviewerStatusOptions}
          />
        </div>
      </GlassCard>

      {/* Batch Action Bar */}
      {selectedIds.length > 0 && (
        <GlassCard padding="sm">
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-300 font-medium">
              {selectedIds.length} selected
            </span>
            <Button
              variant="success"
              size="sm"
              onClick={() => handleBatchDecision('approved')}
              loading={batchLoading}
              disabled={batchLoading}
            >
              Approve All
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => handleBatchDecision('rejected')}
              loading={batchLoading}
              disabled={batchLoading}
            >
              Reject All
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedIds([])}
              disabled={batchLoading}
            >
              Clear
            </Button>
          </div>
        </GlassCard>
      )}

      {/* Enforcement Table */}
      <EnforcementTable
        items={items}
        onApprove={handleApprove}
        onReject={handleReject}
        onRowClick={setDetailItem}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
        actionLoadingId={actionLoading}
      />

      {/* Detail Modal */}
      <EnforcementDetailModal
        item={detailItem}
        isOpen={detailItem !== null}
        onClose={() => setDetailItem(null)}
        onApprove={handleApprove}
        onReject={handleReject}
        actionLoadingId={actionLoading}
      />
    </div>
  );
}
