'use client';

import { useState, useMemo, useCallback } from 'react';
import { format } from 'date-fns';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Eye, RefreshCw, Download, RotateCcw, Info } from 'lucide-react';
import { SearchInput } from '@/components/ui/search-input';
import { Select } from '@/components/ui/select';
import { Collapsible } from '@/components/ui/collapsible';
import { DataTable } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatCard } from '@/components/ui/stat-card';
import { DateRangeFilter } from '@/components/ui/date-range-filter';
import { SegmentToggle } from '@/components/ui/segment-toggle';
import { ReportDownloadButtons } from '@/components/violations/report-download-buttons';
import { VIOLATION_LABELS } from '@/config/violations';
import { formatCurrency, formatDateTime } from '@/lib/utils/format';

import { usePlatformViolations } from '@/hooks/use-platform-violations';
import { useChallengeViolations } from '@/hooks/use-challenge-violations';

// Build deduplicated type list + reverse lookup (label -> all matching type keys)
const ALL_VIOLATION_LABELS: Record<string, string> = {
  ...VIOLATION_LABELS,
  overnight: 'Overnight',
  violations: 'Violations (General)',
};

const VIOLATION_TYPES = (() => {
  const seen = new Set<string>();
  return Object.entries(ALL_VIOLATION_LABELS)
    .filter(([, label]) => { if (seen.has(label)) return false; seen.add(label); return true; })
    .map(([value, label]) => ({ value, label }));
})();

// Map each canonical key to all alias keys sharing the same label
const TYPE_ALIASES: Record<string, string[]> = {};
for (const { value, label } of VIOLATION_TYPES) {
  TYPE_ALIASES[value] = Object.entries(ALL_VIOLATION_LABELS)
    .filter(([, l]) => l === label)
    .map(([k]) => k);
}

const BADGE_VARIANT: Record<string, 'red' | 'yellow' | 'blue' | 'purple' | 'green' | 'silver'> = {
  overleveraging: 'yellow', hft: 'blue',
  martingale: 'purple', news: 'green', grid: 'silver', copy: 'red',
  violations: 'red', overnight: 'yellow',
};

const VIOLATION_DESCRIPTIONS: Record<string, string> = {
  hft: 'HFT violations flag trades held for less than 1 minute. If 5+ sub-minute trades are detected, all their profits are deducted.',
  martingale: 'Martingale violations occur when lot size increases by more than 1.5x after consecutive losses, indicating a doubling-down strategy.',
  overleveraging: 'Over Leverage violations flag trades with lot size exceeding 3x the account average. Requires 3+ overleveraged trades to trigger.',
  news: 'News Trading violations flag trades opened within 5 minutes of the hour and held under 30 minutes. Requires 3+ matching trades.',
  grid: 'Grid Trading violations detect 5+ trades on the same instrument placed at regular price intervals (60%+ uniformity).',
  copy: 'Copy Trading violations flag trades mirroring another account — matching symbols, similar timing, and near-identical lot sizes.',
  overnight: 'Overnight violations flag positions held through market close/open, exposing the account to gap risk.',
};

function ViolationGroup({ group, columns, perPage }: {
  group: { type: string; label: string; items: any[] };
  columns: any[];
  perPage: number;
}) {
  const [groupPage, setGroupPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(group.items.length / perPage));
  const paginatedItems = group.items.slice((groupPage - 1) * perPage, groupPage * perPage);

  return (
    <Collapsible title={group.label} count={group.items.length} defaultOpen={group.items.length > 0 && group.items.length <= 30}>
      {VIOLATION_DESCRIPTIONS[group.type] && (
        <div className="px-4 py-2.5 border-b border-white/5 bg-white/[0.01]">
          <p className="text-[10px] text-gray-500 leading-relaxed">{VIOLATION_DESCRIPTIONS[group.type]}</p>
        </div>
      )}
      <DataTable columns={columns} data={paginatedItems} emptyMessage={`No ${group.label} violations found`} />
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-white/10">
          <span className="text-[10px] text-gray-500">
            Page {groupPage} of {totalPages} ({group.items.length} total)
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setGroupPage(Math.max(1, groupPage - 1))}
              disabled={groupPage === 1}
              className="px-2.5 py-1 text-[10px] rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30"
            >
              Previous
            </button>
            <button
              onClick={() => setGroupPage(Math.min(totalPages, groupPage + 1))}
              disabled={groupPage >= totalPages}
              className="px-2.5 py-1 text-[10px] rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </Collapsible>
  );
}

function ChallengeViolationsContent() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const perPage = 25;

  const { data, loading, error, searching, refetch } = useChallengeViolations({
    search: search || undefined,
    violationType: typeFilter || undefined,
    perPage: 500,
  });

  const violations = useMemo(() => data?.data || [], [data?.data]);

  const filteredViolations = useMemo(() => {
    let items = violations;
    if (startDate) {
      const start = new Date(startDate);
      items = items.filter((v: any) => new Date(v.detectedAt) >= start);
    }
    if (endDate) {
      const end = new Date(endDate + 'T23:59:59');
      items = items.filter((v: any) => new Date(v.detectedAt) <= end);
    }
    return items;
  }, [violations, startDate, endDate]);

  const groupedByType = useMemo(() => {
    const typeSet = new Set(filteredViolations.map((v: any) => v.violationType));
    return VIOLATION_TYPES
      .filter((t) => {
        const aliases = TYPE_ALIASES[t.value] || [t.value];
        return aliases.some((k) => typeSet.has(k)) || (typeFilter && aliases.includes(typeFilter));
      })
      .map(({ value, label }) => {
        const aliases = new Set(TYPE_ALIASES[value] || [value]);
        return {
          type: value,
          label,
          items: filteredViolations.filter((v: any) => aliases.has(v.violationType)),
        };
      })
      .filter((g) => {
        if (!typeFilter) return true;
        const aliases = TYPE_ALIASES[g.type] || [g.type];
        return aliases.includes(typeFilter);
      });
  }, [filteredViolations, typeFilter]);

  const totalDeductions = filteredViolations.reduce((s: number, v: any) => s + (v.totalDeduction || 0), 0);
  const uniqueTypes = new Set(filteredViolations.map((v: any) => ALL_VIOLATION_LABELS[v.violationType] || v.violationType)).size;

  const handleExport = useCallback(() => {
    if (filteredViolations.length === 0) return;
    const headers = ['Date', 'Login', 'Email', 'Name', 'Phase', 'Plan', 'Country', 'Violation', 'Severity', 'Deduction'];
    const rows = filteredViolations.map((v: any) => [
      v.detectedAt ? format(new Date(v.detectedAt), 'MM/dd/yyyy HH:mm') : '',
      v.login || '',
      v.email || '',
      [v.firstName, v.lastName].filter(Boolean).join(' '),
      v.phaseLabel || '',
      v.plan || '',
      v.country || '',
      v.violationLabel || v.violationType || '',
      v.severity || '',
      (v.totalDeduction || 0).toFixed(2),
    ].map((f) => `"${String(f).replace(/"/g, '""')}"`).join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `challenge_violations_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [filteredViolations]);

  const challengeColumns = [
    {
      key: 'detectedAt',
      header: 'Date',
      render: (item: any) => (
        <span className="text-gray-400 text-[11px] whitespace-nowrap">{formatDateTime(item.detectedAt)}</span>
      ),
    },
    {
      key: 'login',
      header: 'Login / Name',
      render: (item: any) => (
        <div className="min-w-0">
          <span className="font-mono text-red-400 text-[11px] font-medium">{item.login || '—'}</span>
          {item.firstName && item.lastName && (
            <span className="block text-gray-500 text-[10px]">{item.firstName} {item.lastName}</span>
          )}
        </div>
      ),
    },
    {
      key: 'phase',
      header: 'Phase',
      render: (item: any) => (
        <Badge variant={item.phase === 1 ? 'blue' : item.phase === 2 ? 'purple' : 'yellow'}>{item.phaseLabel}</Badge>
      ),
    },
    {
      key: 'plan',
      header: 'Plan',
      render: (item: any) => (
        <span className="text-gray-300 text-[11px] whitespace-nowrap truncate block max-w-[120px]">{item.plan || '—'}</span>
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
      key: 'violationType',
      header: 'Violation',
      render: (item: any) => (
        <div className="flex items-center gap-1 group relative">
          <Badge variant={BADGE_VARIANT[item.violationType] || 'red'}>{item.violationLabel}</Badge>
          {item.severity && (
            <Badge variant={item.severity === 'critical' || item.severity === 'high' ? 'red' : item.severity === 'medium' ? 'yellow' : 'blue'}>
              {item.severity}
            </Badge>
          )}
          {VIOLATION_DESCRIPTIONS[item.violationType] && (
            <div className="relative">
              <Info className="h-3 w-3 text-gray-600 hover:text-gray-400 cursor-help" />
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 p-3 rounded-lg bg-[#1a1a1f] border border-white/15 shadow-xl text-[10px] text-gray-400 leading-relaxed opacity-0 pointer-events-none hover:opacity-100 hover:pointer-events-auto [.group:hover_&]:opacity-100 [.group:hover_&]:pointer-events-auto z-50 transition-opacity">
                <span className="text-white font-semibold text-[11px] block mb-1">{item.violationLabel}</span>
                {VIOLATION_DESCRIPTIONS[item.violationType]}
              </div>
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'totalDeduction',
      header: 'Deduction',
      render: (item: any) => (
        <span className="text-red-400 font-semibold text-[11px] whitespace-nowrap">{formatCurrency(item.totalDeduction)}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (item: any) => (
        <div className="flex items-center justify-end gap-1">
          {/* Challenge rows come from the challenge dataset, which has no
              addressable per-violation record — the account-level export is
              the honest link. */}
          <ReportDownloadButtons accountId={item.accountId} size="icon" />
          <Button variant="ghost" size="sm" className="!px-2 !py-1" onClick={() => router.push(`/violations/account/${item.accountId}`)}>
            <Eye className="h-3 w-3 mr-1" /> Details
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold bg-gradient-to-r from-red-400 to-orange-400 bg-clip-text text-transparent">
          Challenge Violation Reports
        </h1>
        <p className="mt-1 text-xs text-gray-500">
          Violations detected from challenge accounts (Phase 1, 2 & 3). Shows account details and deduction amounts.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search login, account, name, email..." className="w-56" />
        <Select value={typeFilter} onChange={setTypeFilter} options={VIOLATION_TYPES} placeholder="All Violation Types" />
        <DateRangeFilter startDate={startDate} endDate={endDate} onStartChange={setStartDate} onEndChange={setEndDate} />
        {(search || typeFilter || startDate || endDate) && (
          <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setTypeFilter(''); setStartDate(''); setEndDate(''); }} className="!text-gray-500 hover:!text-gray-300">
            <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reset
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={refetch} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
        <Button variant="secondary" size="sm" onClick={handleExport}>
          <Download className="h-3.5 w-3.5 mr-1.5" /> Export CSV
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard title="Total Violations" value={filteredViolations.length} icon={AlertTriangle} />
        <StatCard title="Violation Types" value={uniqueTypes} icon={AlertTriangle} />
        <StatCard title="Total Deductions" value={formatCurrency(totalDeductions)} icon={AlertTriangle} />
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          Failed to load violations: {error}
        </div>
      )}

      {loading && violations.length === 0 && (
        <div className="flex items-center justify-center h-32 text-gray-500">
          <RefreshCw className="h-5 w-5 animate-spin mr-2" /> Analyzing challenge accounts for violations...
        </div>
      )}

      <div className="space-y-3">
        {groupedByType.map((group) => (
          <ViolationGroup key={group.type} group={group} columns={challengeColumns} perPage={perPage} />
        ))}
      </div>

      {(loading || searching) && filteredViolations.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          <RefreshCw className="h-8 w-8 mx-auto mb-3 animate-spin opacity-30" />
          <p>{searching ? 'Searching the Trading Platform for this account...' : 'Loading...'}</p>
        </div>
      )}

      {!loading && !searching && filteredViolations.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          <AlertTriangle className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p>No violations detected{search ? ` for "${search}"` : ' across challenge accounts'}.</p>
        </div>
      )}
    </div>
  );
}

export default function ViolationsPage() {
  const [segment, setSegment] = useState('funded');
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const perPage = 25;

  const { data, loading, refetch } = usePlatformViolations({
    search: search || undefined,
    violationType: typeFilter || undefined,
    perPage: 500,
  });

  const violations = useMemo(() => data?.data || [], [data?.data]);

  // Client-side date filter
  const filteredViolations = useMemo(() => {
    let items = violations;
    if (startDate) {
      const start = new Date(startDate);
      items = items.filter((v: any) => new Date(v.detectedAt) >= start);
    }
    if (endDate) {
      const end = new Date(endDate + 'T23:59:59');
      items = items.filter((v: any) => new Date(v.detectedAt) <= end);
    }
    return items;
  }, [violations, startDate, endDate]);

  // Group by violation type (using aliases so related keys share the same label)
  const groupedByType = useMemo(() => {
    const typeSet = new Set(filteredViolations.map((v: any) => v.violationType));
    return VIOLATION_TYPES
      .filter((t) => {
        const aliases = TYPE_ALIASES[t.value] || [t.value];
        return aliases.some((k) => typeSet.has(k)) || (typeFilter && aliases.includes(typeFilter));
      })
      .map(({ value, label }) => {
        const aliases = new Set(TYPE_ALIASES[value] || [value]);
        return {
          type: value,
          label,
          items: filteredViolations.filter((v: any) => aliases.has(v.violationType)),
        };
      })
      .filter((g) => {
        if (!typeFilter) return true;
        const aliases = TYPE_ALIASES[g.type] || [g.type];
        return aliases.includes(typeFilter);
      });
  }, [filteredViolations, typeFilter]);

  const totalDeductions = filteredViolations.reduce((s: number, v: any) => s + (v.totalDeduction || 0), 0);
  const uniqueTypes = new Set(filteredViolations.map((v: any) => ALL_VIOLATION_LABELS[v.violationType] || v.violationType)).size;

  const handleExport = useCallback(() => {
    if (filteredViolations.length === 0) return;
    const headers = ['Date', 'Login', 'Email', 'Name', 'Plan', 'Country', 'KYC', 'Violation', 'Severity', 'Deduction'];
    const rows = filteredViolations.map((v: any) => [
      v.detectedAt ? format(new Date(v.detectedAt), 'MM/dd/yyyy HH:mm') : '',
      v.login || '',
      v.email || '',
      [v.firstName, v.lastName].filter(Boolean).join(' '),
      v.plan || '',
      v.country || '',
      v.kycStatus || '',
      v.violationLabel || v.violationType || '',
      v.severity || '',
      (v.totalDeduction || 0).toFixed(2),
    ].map((f) => `"${String(f).replace(/"/g, '""')}"`).join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `violations_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [filteredViolations]);

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
      header: 'Login / Name',
      render: (item: any) => (
        <div className="min-w-0">
          <span className="font-mono text-red-400 text-[11px] font-medium">{item.login || '—'}</span>
          {item.firstName && item.lastName && (
            <span className="block text-gray-500 text-[10px]">{item.firstName} {item.lastName}</span>
          )}
        </div>
      ),
    },
    {
      key: 'plan',
      header: 'Plan',
      render: (item: any) => (
        <span className="text-gray-300 text-[11px] whitespace-nowrap">{item.plan || '—'}</span>
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
      key: 'kycStatus',
      header: 'KYC',
      render: (item: any) => (
        <Badge variant={item.kycStatus === 'Verified' ? 'green' : 'yellow'}>{item.kycStatus || '—'}</Badge>
      ),
    },
    {
      key: 'violationType',
      header: 'Violation',
      render: (item: any) => (
        <div className="flex items-center gap-1 group relative">
          <Badge variant={BADGE_VARIANT[item.violationType] || 'red'}>{item.violationLabel}</Badge>
          {item.severity && (
            <Badge
              variant={
                item.severity === 'critical' || item.severity === 'high' ? 'red' :
                item.severity === 'medium' ? 'yellow' : 'blue'
              }
            >
              {item.severity}
            </Badge>
          )}
          {VIOLATION_DESCRIPTIONS[item.violationType] && (
            <div className="relative">
              <Info className="h-3 w-3 text-gray-600 hover:text-gray-400 cursor-help" />
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 p-3 rounded-lg bg-[#1a1a1f] border border-white/15 shadow-xl text-[10px] text-gray-400 leading-relaxed opacity-0 pointer-events-none hover:opacity-100 hover:pointer-events-auto [.group:hover_&]:opacity-100 [.group:hover_&]:pointer-events-auto z-50 transition-opacity">
                <span className="text-white font-semibold text-[11px] block mb-1">{item.violationLabel}</span>
                {VIOLATION_DESCRIPTIONS[item.violationType]}
              </div>
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'totalDeduction',
      header: 'Deduction',
      render: (item: any) => (
        <span className="text-red-400 font-semibold text-[11px] whitespace-nowrap">{formatCurrency(item.totalDeduction)}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (item: any) => (
        <div className="flex items-center justify-end gap-1">
          <ReportDownloadButtons violationId={item.id} accountId={item.accountId} size="icon" />
          <Button variant="ghost" size="sm" className="!px-2 !py-1" onClick={() => router.push(`/violations/account/${item.accountId}`)}>
            <Eye className="h-3 w-3 mr-1" /> Details
          </Button>
        </div>
      ),
    },
  ];

  const violationSegments = [
    { id: 'funded', label: 'Funded Payouts' },
    { id: 'challenges', label: 'Challenges' },
  ];

  if (segment === 'challenges') {
    return (
      <div className="space-y-5">
        <div className="flex items-center gap-4">
          <SegmentToggle segments={violationSegments} active={segment} onChange={setSegment} />
        </div>
        <ChallengeViolationsContent />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-red-400 to-orange-400 bg-clip-text text-transparent">
            Violation Reports
          </h1>
          <p className="mt-1 text-xs text-gray-500">
            Violations detected from Trading Platform pending payout accounts. Shows account details, KYC status, and deduction amounts.
          </p>
        </div>
        <SegmentToggle segments={violationSegments} active={segment} onChange={setSegment} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search login, account, name, email..." className="w-56" />
        <Select value={typeFilter} onChange={setTypeFilter} options={VIOLATION_TYPES} placeholder="All Violation Types" />
        <DateRangeFilter startDate={startDate} endDate={endDate} onStartChange={setStartDate} onEndChange={setEndDate} />
        {(search || typeFilter || startDate || endDate) && (
          <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setTypeFilter(''); setStartDate(''); setEndDate(''); }} className="!text-gray-500 hover:!text-gray-300">
            <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reset
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={refetch} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
        <Button variant="secondary" size="sm" onClick={handleExport}>
          <Download className="h-3.5 w-3.5 mr-1.5" />
          Export CSV
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard title="Total Violations" value={filteredViolations.length} icon={AlertTriangle} />
        <StatCard title="Violation Types" value={uniqueTypes} icon={AlertTriangle} />
        <StatCard title="Total Deductions" value={formatCurrency(totalDeductions)} icon={AlertTriangle} />
      </div>

      {loading && violations.length === 0 && (
        <div className="flex items-center justify-center h-32 text-gray-500">
          <RefreshCw className="h-5 w-5 animate-spin mr-2" />
          Analyzing pending payout accounts for violations...
        </div>
      )}

      <div className="space-y-3">
        {groupedByType.map((group) => (
          <ViolationGroup key={group.type} group={group} columns={columns} perPage={perPage} />
        ))}
      </div>

      {!loading && filteredViolations.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          <AlertTriangle className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p>No violations detected across pending payout accounts.</p>
        </div>
      )}
    </div>
  );
}
