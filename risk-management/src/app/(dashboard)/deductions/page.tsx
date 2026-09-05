'use client';

import { useState, useMemo, useCallback } from 'react';
import { format } from 'date-fns';
import { DollarSign, TrendingDown, AlertTriangle, BarChart3, RefreshCw, Download, RotateCcw, Info, Calculator, ArrowRightLeft, ShieldAlert } from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';
import { StatCard } from '@/components/ui/stat-card';
import { DataTable } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { SearchInput } from '@/components/ui/search-input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { DateRangeFilter } from '@/components/ui/date-range-filter';
import { toCsv, csvFilename, downloadCsv } from '@/lib/export';
import { ViolationTypeBreakdown } from '@/components/charts/breakdown-cards';
import { usePlatformDeductions, usePlatformDeductionsSummary } from '@/hooks/use-platform-deductions';
import { formatCurrency, formatDateTime } from '@/lib/utils/format';


const VIOLATION_TYPE_LABELS: Record<string, string> = {
  overleveraging: 'Overleveraging',
  hft: 'HFT',
  martingale: 'Martingale',
  news: 'News Trading',
  grid: 'Grid Trading',
  copy: 'Copy Trading',
  violations: 'Violations',
  overnight: 'Overnight',
};

const BADGE_VARIANT: Record<string, 'red' | 'yellow' | 'blue' | 'purple' | 'green' | 'silver'> = {
  overleveraging: 'yellow', hft: 'blue',
  martingale: 'purple', news: 'green', grid: 'silver', copy: 'red', violations: 'red', overnight: 'yellow',
};

const VIOLATION_OPTIONS = (() => {
  const seen = new Set<string>();
  const opts: { value: string; label: string }[] = [{ value: '', label: 'All Types' }];
  for (const [value, label] of Object.entries(VIOLATION_TYPE_LABELS)) {
    if (seen.has(label)) continue;
    seen.add(label);
    opts.push({ value, label });
  }
  return opts;
})();

const DEDUCTION_DESCRIPTIONS: Record<string, string> = {
  hft: 'High Frequency Trading (HFT) violations flag trades held for less than 1 minute. If 5 or more sub-minute trades are detected, all their profits are deducted. This rule prevents latency arbitrage and tick-scalping strategies.',
  martingale: 'Martingale violations occur when a trader increases lot size by more than 1.5x after consecutive losses, indicating a doubling-down strategy. The escalated trade\'s profit is deducted.',
  overleveraging: 'Over Leverage violations flag trades with lot size exceeding 3x the account average. Requires 3+ overleveraged trades to trigger.',
  news: 'News Trading violations flag trades opened within 5 minutes of the hour and held under 30 minutes. Requires 3+ matching trades to trigger.',
  grid: 'Grid Trading violations detect 5+ trades on the same instrument placed at regular price intervals (60%+ uniformity).',
  copy: 'Copy Trading violations flag trades mirroring another account — matching symbols, similar timing, and near-identical lot sizes. Requires 5+ copied trades with 70%+ similarity.',
  overnight: 'Overnight violations flag positions held through the market close/open session, exposing the account to gap risk.',
};

export default function DeductionsPage() {
  const [page, setPage] = useState(1);
  const perPage = 20;
  const [search, setSearch] = useState('');
  const [violationType, setViolationType] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const [flaggedModalOpen, setFlaggedModalOpen] = useState(false);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [internalModalPage, setInternalModalPage] = useState(1);
  const [providerModalPage, setProviderModalPage] = useState(1);
  const modalPerPage = 10;

  const { data: deductionsList, loading: listLoading, refetch } = usePlatformDeductions({
    search: search || undefined,
    violationType: violationType || undefined,
    page: 1,
    perPage: 500,
  });
  const { data: summary, loading: summaryLoading } = usePlatformDeductionsSummary();

  // Client-side date filtering + pagination
  const filteredData = useMemo(() => {
    let items = deductionsList?.data || [];
    if (startDate) {
      const start = new Date(startDate);
      items = items.filter((d: any) => new Date(d.detectedAt) >= start);
    }
    if (endDate) {
      const end = new Date(endDate + 'T23:59:59');
      items = items.filter((d: any) => new Date(d.detectedAt) <= end);
    }
    return items;
  }, [deductionsList, startDate, endDate]);

  const paginatedData = useMemo(() => {
    return filteredData.slice((page - 1) * perPage, page * perPage);
  }, [filteredData, page]);

  const totalPages = Math.max(1, Math.ceil(filteredData.length / perPage));

  const handleExport = useCallback(() => {
    if (filteredData.length === 0) return;
    const csv = toCsv(filteredData, [
      { header: 'Date', value: (d: any) => (d.detectedAt ? format(new Date(d.detectedAt), 'MM/dd/yyyy HH:mm') : '') },
      { header: 'Login', value: (d: any) => d.login || '' },
      { header: 'Email', value: (d: any) => d.email || '' },
      { header: 'Name', value: (d: any) => [d.firstName, d.lastName].filter(Boolean).join(' ') },
      { header: 'Violation Type', value: (d: any) => d.violationLabel || d.violationType || '' },
      { header: 'Plan', value: (d: any) => d.plan || '' },
      { header: 'Account Size', value: (d: any) => d.startingBalance || '' },
      { header: 'Country', value: (d: any) => d.country || '' },
      { header: 'Amount Deducted', value: (d: any) => (d.deductionAmount || 0).toFixed(2) },
      { header: 'Details', value: (d: any) => d.explanation || d.deductionNote || '' },
    ]);
    downloadCsv(csvFilename('deductions'), csv);
  }, [filteredData]);

  const columns = [
    {
      key: 'detectedAt',
      header: 'Date',
      render: (item: any) => (
        <span className="text-gray-400 text-[11px] whitespace-nowrap">{formatDateTime(item.detectedAt)}</span>
      ),
    },
    {
      key: 'login',
      header: 'Account',
      render: (item: any) => (
        <div className="min-w-0 max-w-[160px]">
          <span className="font-mono text-red-400 text-[11px] font-medium">{item.login || '—'}</span>
          {item.firstName && item.lastName && (
            <span className="block text-gray-500 text-[10px] truncate">{item.firstName} {item.lastName}</span>
          )}
          {item.email && (
            <span className="block text-gray-600 text-[10px] truncate">{item.email}</span>
          )}
        </div>
      ),
    },
    {
      key: 'violationType',
      header: 'Type',
      render: (item: any) => (
        <div className="flex items-center gap-1 group relative">
          <Badge variant={BADGE_VARIANT[item.violationType] || 'red'}>
            {item.violationLabel || VIOLATION_TYPE_LABELS[item.violationType] || item.violationType}
          </Badge>
          {DEDUCTION_DESCRIPTIONS[item.violationType] && (
            <div className="relative">
              <Info className="h-3 w-3 text-gray-600 hover:text-gray-400 cursor-help" />
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 p-3 rounded-lg bg-[#1a1a1f] border border-white/15 shadow-xl text-[10px] text-gray-400 leading-relaxed opacity-0 pointer-events-none hover:opacity-100 hover:pointer-events-auto [.group:hover_&]:opacity-100 [.group:hover_&]:pointer-events-auto z-50 transition-opacity">
                <span className="text-white font-semibold text-[11px] block mb-1">{VIOLATION_TYPE_LABELS[item.violationType]}</span>
                {DEDUCTION_DESCRIPTIONS[item.violationType]}
              </div>
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'plan',
      header: 'Plan / Size',
      render: (item: any) => (
        <div className="min-w-0">
          <span className="text-gray-300 text-[11px] whitespace-nowrap block truncate max-w-[100px]">{item.plan || '—'}</span>
          {item.startingBalance > 0 && (
            <span className="text-gray-500 text-[10px] block">{formatCurrency(item.startingBalance)}</span>
          )}
        </div>
      ),
    },
    {
      key: 'country',
      header: 'Country',
      render: (item: any) => (
        <span className="text-gray-400 text-[11px]">{item.country || '—'}</span>
      ),
    },
    {
      key: 'deductionAmount',
      header: 'Deducted',
      render: (item: any) => (
        <span className="text-red-400 font-semibold text-[11px] whitespace-nowrap">{formatCurrency(item.deductionAmount)}</span>
      ),
    },
    {
      key: 'explanation',
      header: 'Details',
      render: (item: any) => (
        <span className="text-gray-500 text-[10px] line-clamp-2 max-w-[220px] block">{item.explanation || item.deductionNote || '—'}</span>
      ),
    },
  ];

  const comparison = summary?.comparison;

  // Derive stat card values from filtered data so they respond to date changes
  const filteredTotalDeductions = useMemo(() =>
    filteredData.reduce((s: number, d: any) => s + (d.deductionAmount || 0), 0),
    [filteredData]
  );
  const filteredUniqueTypes = useMemo(() =>
    new Set(filteredData.map((d: any) => VIOLATION_TYPE_LABELS[d.violationType] || d.violationType)).size,
    [filteredData]
  );
  const filteredUniqueAccounts = useMemo(() =>
    new Set(filteredData.map((d: any) => d.login || d.accountId)).size,
    [filteredData]
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold bg-gradient-to-r from-red-400 to-orange-400 bg-clip-text text-transparent">
          Executed Deductions
        </h1>
        <p className="mt-1 text-xs text-gray-500">
          Deductions applied to pending payout accounts from Trading Platform risk violation analysis.
        </p>
      </div>

      {/* Internal vs Trading Platform Reported comparison */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard
          title="Internal Analysis"
          value={comparison ? formatCurrency(comparison.calculated) : '—'}
          icon={Calculator}
          info="Total deductions found by our internal trade-level analysis. News trading violations are only counted when confirmed against real economic events from FXStreet and Forex Factory. This may differ from what the Trading Platform reports."
          subtitle={comparison ? `${comparison.calculated_count} found · ${comparison.flagged_deductions?.length || 0} flagged` : undefined}
          onClick={() => setFlaggedModalOpen(true)}
        />
        <StatCard
          title="Trading Platform Analysis"
          value={comparison ? formatCurrency(comparison.platform_reported) : '—'}
          icon={DollarSign}
          info="Total deductions reported by the Trading Platform's own analysis, including news trading violations that may not have matching economic events."
          subtitle={comparison ? `${comparison.platform_count} reported deductions` : undefined}
          onClick={() => setProviderModalOpen(true)}
        />
        <StatCard
          title="Difference"
          value={comparison ? formatCurrency(comparison.difference) : '—'}
          icon={ArrowRightLeft}
          info="The gap between Trading Platform Analysis and Internal Analysis. Typically caused by news trading violations where no matching economic event was found from FXStreet or Forex Factory."
          subtitle={comparison?.difference > 0 ? `${comparison.difference_count} unverified news deduction${comparison.difference_count !== 1 ? 's' : ''} removed` : 'No discrepancy'}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          title="Total Deductions"
          value={formatCurrency(filteredTotalDeductions)}
          icon={DollarSign}
          subtitle={`${filteredData.length} total`}
        />
        <StatCard
          title="Avg per Deduction"
          value={filteredData.length > 0 ? formatCurrency(filteredTotalDeductions / filteredData.length) : '—'}
          icon={TrendingDown}
        />
        <StatCard
          title="Violation Types"
          value={filteredUniqueTypes}
          icon={AlertTriangle}
        />
        <StatCard
          title="Accounts Affected"
          value={filteredUniqueAccounts}
          icon={BarChart3}
        />
      </div>

      {/* Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ViolationTypeBreakdown data={summary?.breakdowns?.by_violation_type || []} loading={summaryLoading} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search login, account, name, email..."
          className="w-56"
        />
        <Select
          value={violationType}
          onChange={setViolationType}
          options={VIOLATION_OPTIONS}
          placeholder="All Types"
        />
        <DateRangeFilter startDate={startDate} endDate={endDate} onStartChange={setStartDate} onEndChange={setEndDate} />
        {(search || violationType || startDate || endDate) && (
          <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setViolationType(''); setStartDate(''); setEndDate(''); }} className="!text-gray-500 hover:!text-gray-300">
            <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reset
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={refetch} disabled={listLoading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${listLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
        <Button variant="secondary" size="sm" onClick={handleExport}>
          <Download className="h-3.5 w-3.5 mr-1.5" />
          Export CSV
        </Button>
      </div>

      {/* Violation type explanation banner */}
      {violationType && DEDUCTION_DESCRIPTIONS[violationType] && (
        <div className="rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-yellow-400 mt-0.5 shrink-0" />
            <div>
              <span className="text-xs font-semibold text-white">{VIOLATION_TYPE_LABELS[violationType]}</span>
              <p className="text-[11px] text-gray-400 leading-relaxed mt-1">{DEDUCTION_DESCRIPTIONS[violationType]}</p>
            </div>
          </div>
        </div>
      )}

      {/* Deductions Table */}
      <GlassCard padding="none">
        <div className="px-4 py-2.5 border-b border-white/10 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-white">All Deductions</h3>
          <span className="text-[10px] text-gray-500">{filteredData.length} records</span>
        </div>
        {listLoading && filteredData.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-gray-500">
            <RefreshCw className="h-5 w-5 animate-spin mr-2" />
            Loading deductions from the Trading Platform...
          </div>
        ) : (
          <DataTable
            columns={columns}
            data={paginatedData}
            emptyMessage="No deductions found"
          />
        )}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/10">
            <span className="text-[10px] text-gray-500">
              Page {page} of {totalPages} ({filteredData.length} total)
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
                className="px-2.5 py-1 text-[10px] rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages}
                className="px-2.5 py-1 text-[10px] rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </GlassCard>

      {/* Internal Analysis Detail Modal */}
      <Modal isOpen={flaggedModalOpen} onClose={() => setFlaggedModalOpen(false)} title="Internal Analysis — Detail" size="lg">
        <div className="space-y-4">
          {/* Summary row */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div className="text-center">
              <span className="block text-[10px] text-gray-500 uppercase tracking-wider">Internal Total</span>
              <span className="text-sm font-bold text-white">{comparison ? formatCurrency(comparison.calculated) : '—'}</span>
            </div>
            <div className="text-center">
              <span className="block text-[10px] text-gray-500 uppercase tracking-wider">Deductions</span>
              <span className="text-sm font-bold text-white">{comparison?.calculated_count || 0}</span>
            </div>
            <div className="text-center">
              <span className="block text-[10px] text-gray-500 uppercase tracking-wider">News Removed</span>
              <span className="text-sm font-bold text-yellow-400">{comparison?.flagged_deductions?.length || 0}</span>
            </div>
          </div>

          {/* Internal analysis deductions per account */}
          <div className="flex items-center justify-between">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Deductions by Account</h4>
            {comparison?.analysis_details && comparison.analysis_details.length > 0 && (
              <Button variant="secondary" size="sm" onClick={() => {
                const csv = toCsv(comparison.analysis_details, [
                  { header: 'Login', value: (d: any) => d.login },
                  { header: 'Account ID', value: (d: any) => d.accountId },
                  { header: 'Plan', value: (d: any) => d.plan },
                  { header: 'Violation Type', value: (d: any) => d.violationLabel },
                  { header: 'Deduction', value: (d: any) => (d.amount || 0).toFixed(2) },
                ]);
                downloadCsv(csvFilename('internal_analysis'), csv);
              }}>
                <Download className="h-3 w-3 mr-1" /> Export
              </Button>
            )}
          </div>
          {comparison?.analysis_details && comparison.analysis_details.length > 0 ? (
            <>
              <DataTable
                columns={[
                  {
                    key: 'login',
                    header: 'Login',
                    render: (item: any) => (
                      <span className="font-mono text-white text-[11px] font-medium">{item.login || '—'}</span>
                    ),
                  },
                  {
                    key: 'violationLabel',
                    header: 'Type',
                    render: (item: any) => (
                      <Badge variant={BADGE_VARIANT[item.violationType] || 'red'}>{item.violationLabel}</Badge>
                    ),
                  },
                  {
                    key: 'plan',
                    header: 'Plan',
                    render: (item: any) => (
                      <span className="text-gray-300 text-[11px] truncate block max-w-[150px]">{item.plan || '—'}</span>
                    ),
                  },
                  {
                    key: 'amount',
                    header: 'Deduction',
                    render: (item: any) => (
                      <span className="text-red-400 font-semibold text-[11px]">{formatCurrency(item.amount)}</span>
                    ),
                  },
                ]}
                data={comparison.analysis_details.slice((internalModalPage - 1) * modalPerPage, internalModalPage * modalPerPage)}
                emptyMessage="No deductions"
              />
              {comparison.analysis_details.length > modalPerPage && (
                <div className="flex items-center justify-between pt-2">
                  <span className="text-[10px] text-gray-500">Page {internalModalPage} of {Math.ceil(comparison.analysis_details.length / modalPerPage)} ({comparison.analysis_details.length} total)</span>
                  <div className="flex gap-2">
                    <button onClick={() => setInternalModalPage(Math.max(1, internalModalPage - 1))} disabled={internalModalPage === 1} className="px-2.5 py-1 text-[10px] rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30">Previous</button>
                    <button onClick={() => setInternalModalPage(Math.min(Math.ceil(comparison.analysis_details.length / modalPerPage), internalModalPage + 1))} disabled={internalModalPage >= Math.ceil(comparison.analysis_details.length / modalPerPage)} className="px-2.5 py-1 text-[10px] rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30">Next</button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-6 text-gray-500">
              <Calculator className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No internally-verified deductions found.</p>
            </div>
          )}

          {/* Flagged (removed) news deductions */}
          {comparison?.flagged_deductions && comparison.flagged_deductions.length > 0 && (
            <>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-yellow-400 pt-2">Removed — Unverified News Violations</h4>
              <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-4 py-2.5">
                <p className="text-[11px] text-yellow-300/80 leading-relaxed">
                  These news trading deductions were reported by the Trading Platform but no matching economic event was confirmed from FXStreet or Forex Factory. They have been excluded from the Internal total.
                </p>
              </div>
              <DataTable
                columns={[
                  {
                    key: 'login',
                    header: 'Login',
                    render: (item: any) => (
                      <span className="font-mono text-white text-[11px] font-medium">{item.login || '—'}</span>
                    ),
                  },
                  {
                    key: 'plan',
                    header: 'Plan',
                    render: (item: any) => (
                      <span className="text-gray-300 text-[11px] truncate block max-w-[150px]">{item.plan || '—'}</span>
                    ),
                  },
                  {
                    key: 'amount',
                    header: 'Amount',
                    render: (item: any) => (
                      <span className="text-red-400 font-semibold text-[11px]">{formatCurrency(item.amount)}</span>
                    ),
                  },
                  {
                    key: 'reason',
                    header: 'Reason',
                    render: (item: any) => (
                      <span className="text-gray-500 text-[10px]">{item.reason}</span>
                    ),
                  },
                ]}
                data={comparison.flagged_deductions}
                emptyMessage="No flagged deductions"
              />
            </>
          )}
        </div>
      </Modal>

      {/* Trading Platform Analysis Detail Modal */}
      <Modal isOpen={providerModalOpen} onClose={() => setProviderModalOpen(false)} title="Trading Platform Analysis — Detail" size="lg">
        <div className="space-y-4">
          {/* Summary row */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div className="text-center">
              <span className="block text-[10px] text-gray-500 uppercase tracking-wider">Trading Platform Total</span>
              <span className="text-sm font-bold text-yellow-400">{comparison ? formatCurrency(comparison.platform_reported) : '—'}</span>
            </div>
            <div className="text-center">
              <span className="block text-[10px] text-gray-500 uppercase tracking-wider">Deductions</span>
              <span className="text-sm font-bold text-white">{comparison?.platform_count || 0}</span>
            </div>
            <div className="text-center">
              <span className="block text-[10px] text-gray-500 uppercase tracking-wider">Vs Internal Difference</span>
              <span className="text-sm font-bold text-yellow-400">{comparison ? formatCurrency(comparison.difference) : '—'}</span>
            </div>
          </div>

          <div className="rounded-lg border border-white/10 bg-white/[0.02] px-4 py-2.5">
            <p className="text-[11px] text-gray-400 leading-relaxed">
              All deductions reported by the Trading Platform&apos;s own analysis, including news trading violations that may not have matching economic events.
            </p>
          </div>

          {/* Platform-reported deductions per account */}
          <div className="flex items-center justify-between">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Deductions by Account</h4>
            {comparison?.platform_details && comparison.platform_details.length > 0 && (
              <Button variant="secondary" size="sm" onClick={() => {
                const csv = toCsv(comparison.platform_details, [
                  { header: 'Login', value: (d: any) => d.login },
                  { header: 'Account ID', value: (d: any) => d.accountId },
                  { header: 'Plan', value: (d: any) => d.plan },
                  { header: 'Violation Type', value: (d: any) => d.violationLabel },
                  { header: 'Deduction', value: (d: any) => (d.amount || 0).toFixed(2) },
                ]);
                downloadCsv(csvFilename('platform_analysis'), csv);
              }}>
                <Download className="h-3 w-3 mr-1" /> Export
              </Button>
            )}
          </div>
          {comparison?.platform_details && comparison.platform_details.length > 0 ? (
            <>
            <DataTable
              columns={[
                {
                  key: 'login',
                  header: 'Login',
                  render: (item: any) => (
                    <span className="font-mono text-white text-[11px] font-medium">{item.login || '—'}</span>
                  ),
                },
                {
                  key: 'violationLabel',
                  header: 'Type',
                  render: (item: any) => (
                    <Badge variant={BADGE_VARIANT[item.violationType] || 'red'}>{item.violationLabel}</Badge>
                  ),
                },
                {
                  key: 'plan',
                  header: 'Plan',
                  render: (item: any) => (
                    <span className="text-gray-300 text-[11px] truncate block max-w-[150px]">{item.plan || '—'}</span>
                  ),
                },
                {
                  key: 'amount',
                  header: 'Deduction',
                  render: (item: any) => (
                    <span className="text-red-400 font-semibold text-[11px]">{formatCurrency(item.amount)}</span>
                  ),
                },
              ]}
              data={comparison.platform_details.slice((providerModalPage - 1) * modalPerPage, providerModalPage * modalPerPage)}
              emptyMessage="No deductions"
            />
            {comparison.platform_details.length > modalPerPage && (
              <div className="flex items-center justify-between pt-2">
                <span className="text-[10px] text-gray-500">Page {providerModalPage} of {Math.ceil(comparison.platform_details.length / modalPerPage)} ({comparison.platform_details.length} total)</span>
                <div className="flex gap-2">
                  <button onClick={() => setProviderModalPage(Math.max(1, providerModalPage - 1))} disabled={providerModalPage === 1} className="px-2.5 py-1 text-[10px] rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30">Previous</button>
                  <button onClick={() => setProviderModalPage(Math.min(Math.ceil(comparison.platform_details.length / modalPerPage), providerModalPage + 1))} disabled={providerModalPage >= Math.ceil(comparison.platform_details.length / modalPerPage)} className="px-2.5 py-1 text-[10px] rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30">Next</button>
                </div>
              </div>
            )}
            </>
          ) : (
            <div className="text-center py-6 text-gray-500">
              <DollarSign className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No Trading Platform deductions reported.</p>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
