'use client';

import { useEffect, useState, useCallback } from 'react';
import { ReviewerStats } from '@/components/reviewer/reviewer-stats';
import { ReviewerRunTable } from '@/components/reviewer/reviewer-run-table';
import { ReviewerCaseTable } from '@/components/reviewer/reviewer-case-table';
import { ReviewerRunModal } from '@/components/reviewer/reviewer-run-modal';
import { ReviewerCaseModal } from '@/components/reviewer/reviewer-case-modal';
import { GlassCard } from '@/components/ui/glass-card';
import { Select } from '@/components/ui/select';
import { FileSearch } from 'lucide-react';
import type { ReviewerRun } from '@/components/reviewer/reviewer-run-table';
import type { ReviewedCase } from '@/components/reviewer/reviewer-case-table';
import { useAssetClass } from '@/components/layout/provider-context';

type TabView = 'runs' | 'cases';

const caseFilterOptions = [
  { value: '', label: 'All Results' },
  { value: 'deduction_confirmed', label: 'Confirmed' },
  { value: 'pending_deduction', label: 'Needs Deduction' },
  { value: 'review_error', label: 'Errors' },
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

export default function ReviewerPage() {
  const assetClass = useAssetClass();
  const [loading, setLoading] = useState(true);
  const [runs, setRuns] = useState<ReviewerRun[]>([]);
  const [cases, setCases] = useState<ReviewedCase[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<TabView>('runs');
  const [selectedRun, setSelectedRun] = useState<ReviewerRun | null>(null);
  const [selectedCase, setSelectedCase] = useState<ReviewedCase | null>(null);
  const [caseFilter, setCaseFilter] = useState('');
  const [violationFilter, setViolationFilter] = useState('');

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/reviewer/runs?assetClass=${assetClass}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setRuns(data.runs ?? []);
        setCases(data.cases ?? []);
        setStats(data.stats ?? null);
      }
    } catch (err) {
      console.error('Failed to fetch reviewer data:', err);
    } finally {
      setLoading(false);
    }
  }, [assetClass]);

  // Clear stale data on asset-class switch.
  useEffect(() => { setRuns([]); setCases([]); setStats(null); setLoading(true); }, [assetClass]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Filter cases client-side
  const filteredCases = cases.filter((c) => {
    if (caseFilter && c.reviewer_status !== caseFilter) return false;
    if (violationFilter && c.violation_type !== violationFilter) return false;
    return true;
  });

  return (
    <div className="space-y-5">
      {/* Page Header */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center h-10 w-10 rounded-xl bg-blue-600/20 border border-blue-500/30">
          <FileSearch className="h-5 w-5 text-blue-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Reviewer Reports</h1>
          <p className="text-xs text-gray-500">Nightly deduction verification against the Trading Platform</p>
        </div>
      </div>

      {/* Stats */}
      <ReviewerStats stats={stats} loading={loading} />

      {/* Tab Switcher */}
      <GlassCard padding="sm">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setActiveTab('runs')}
            className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              activeTab === 'runs'
                ? 'bg-white/10 text-white border border-white/20'
                : 'text-gray-400 hover:text-gray-200 hover:bg-white/5 border border-transparent'
            }`}
          >
            Run History ({runs.length})
          </button>
          <button
            onClick={() => setActiveTab('cases')}
            className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              activeTab === 'cases'
                ? 'bg-white/10 text-white border border-white/20'
                : 'text-gray-400 hover:text-gray-200 hover:bg-white/5 border border-transparent'
            }`}
          >
            Reviewed Cases ({cases.length})
          </button>
        </div>
      </GlassCard>

      {/* Content */}
      {activeTab === 'runs' ? (
        <ReviewerRunTable runs={runs} onRowClick={setSelectedRun} />
      ) : (
        <>
          {/* Case Filters */}
          <GlassCard padding="sm">
            <div className="flex flex-wrap items-center gap-3">
              <Select
                value={caseFilter}
                onChange={setCaseFilter}
                options={caseFilterOptions}
                placeholder="All Results"
              />
              <Select
                value={violationFilter}
                onChange={setViolationFilter}
                options={violationTypeOptions}
                placeholder="All Types"
              />
              <span className="text-[11px] text-gray-500 ml-auto">
                {filteredCases.length} of {cases.length} cases
              </span>
            </div>
          </GlassCard>
          <ReviewerCaseTable cases={filteredCases} onRowClick={setSelectedCase} />
        </>
      )}

      {/* Modals */}
      <ReviewerRunModal
        run={selectedRun}
        isOpen={selectedRun !== null}
        onClose={() => setSelectedRun(null)}
      />
      <ReviewerCaseModal
        item={selectedCase}
        isOpen={selectedCase !== null}
        onClose={() => setSelectedCase(null)}
      />
    </div>
  );
}
