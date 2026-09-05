'use client';

import { useEffect, useState, useCallback } from 'react';
import { Scale, Plus } from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { DisputeTable } from '@/components/disputes/dispute-table';
import { DisputeDetailModal } from '@/components/disputes/dispute-detail-modal';
import { OpenDisputeModal } from '@/components/disputes/open-dispute-modal';
import { OverturnRatePanel } from '@/components/disputes/overturn-rate-panel';
import { ReportDownloadButtons } from '@/components/violations/report-download-buttons';
import { Badge } from '@/components/ui/badge';
import type { Dispute } from '@/lib/disputes/types';

const statusOptions = [
  { value: '', label: 'All Statuses' },
  { value: 'open', label: 'Open' },
  { value: 'under_review', label: 'Under Review' },
  { value: 'upheld', label: 'Upheld' },
  { value: 'overturned', label: 'Overturned' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

const subjectTypeOptions = [
  { value: '', label: 'All Subjects' },
  { value: 'breach', label: 'Breach' },
  { value: 'payout', label: 'Payout' },
  { value: 'deduction', label: 'Deduction' },
];

/**
 * Dispute queue (docs/HOW-IT-WORKS.md §6.4) — matches the enforcement queue's
 * shape and interaction model: filterable table, detail modal for the case
 * itself, resolve with a note.
 */
export default function DisputesPage() {
  const [items, setItems] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [subjectTypeFilter, setSubjectTypeFilter] = useState('');
  const [detailItem, setDetailItem] = useState<Dispute | null>(null);
  const [openModal, setOpenModal] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setFetchError(null);
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (subjectTypeFilter) params.set('subjectType', subjectTypeFilter);

      const res = await fetch(`/api/disputes?${params.toString()}`, { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        setItems(json.data ?? []);
      } else {
        setFetchError(`Disputes API returned ${res.status}: ${await res.text()}`);
      }
    } catch (err: any) {
      setFetchError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, subjectTypeFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Only breach cases name a violation; see the panel below for why.
  const breachCases = items.filter((d) => d.subjectType === 'breach' && d.subjectId);

  return (
    <div className="space-y-5">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center h-10 w-10 rounded-xl bg-red-600/20 border border-red-500/30">
            <Scale className="h-5 w-5 text-red-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Disputes</h1>
            <p className="text-xs text-gray-500">Trader disputes against breach, payout, and deduction decisions</p>
          </div>
        </div>
        <Button variant="primary" size="sm" onClick={() => setOpenModal(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Open Dispute
        </Button>
      </div>

      {fetchError && (
        <div className="rounded-lg border border-red-500/50 bg-red-900/30 px-4 py-2 text-xs text-red-300">
          {fetchError}
        </div>
      )}

      <OverturnRatePanel />

      {/* Filter Bar */}
      <GlassCard padding="sm">
        <div className="flex flex-wrap items-center gap-3">
          <Select value={statusFilter} onChange={setStatusFilter} options={statusOptions} />
          <Select value={subjectTypeFilter} onChange={setSubjectTypeFilter} options={subjectTypeOptions} />
        </div>
      </GlassCard>

      <DisputeTable items={loading ? [] : items} onRowClick={setDetailItem} />

      {/*
        The decision record behind each disputed breach. A dispute with
        subjectType 'breach' carries the violation id as its subjectId (see
        src/lib/disputes/lifecycle.ts and the trader report route), so the
        report is directly addressable; payout and deduction cases are not
        violations and are deliberately absent rather than linked to something
        that would 404.
      */}
      {breachCases.length > 0 && (
        <GlassCard padding="sm">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            Decision records for disputed breaches
          </h3>
          <div className="divide-y divide-white/5">
            {breachCases.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant="default">{d.status}</Badge>
                  <span className="font-mono text-[10px] text-gray-500">{d.subjectId}</span>
                  <span className="text-[10px] text-gray-500">raised by {d.raisedBy}</span>
                </div>
                <ReportDownloadButtons
                  violationId={d.subjectId}
                  accountId={d.accountId ?? undefined}
                  size="icon"
                />
              </div>
            ))}
          </div>
        </GlassCard>
      )}

      <OpenDisputeModal isOpen={openModal} onClose={() => setOpenModal(false)} onOpened={fetchData} />

      <DisputeDetailModal
        dispute={detailItem}
        isOpen={detailItem !== null}
        onClose={() => setDetailItem(null)}
        onChanged={fetchData}
      />
    </div>
  );
}
