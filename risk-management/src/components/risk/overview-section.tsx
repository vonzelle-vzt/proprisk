import { AlertTriangle } from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/ui/data-table';
import { formatCurrency } from '@/lib/utils/format';
import type { DashboardAccount } from '@/hooks/use-platform-dashboard';
import { SEVERITY_BADGE, SEVERITY_COLORS } from './constants';
import { SeverityDistributionCard } from './severity-distribution-card';
import { ViolationBreakdownCard } from './violation-breakdown-card';
import { PlanCountryDistribution } from './plan-country-distribution';

interface OverviewSectionProps {
  severity: { critical: number; high: number; medium: number; low: number };
  violationBreakdown: { type: string; label: string; count: number; amount: number }[];
  planDist: { plan: string; count: number; totalPayout: number }[];
  countryDist: { country: string; count: number }[];
  flagged: DashboardAccount[];
  onViewAllFlagged: () => void;
}

/** "Overview" tab content on the funded-payouts risk dashboard. */
export function OverviewSection({ severity, violationBreakdown, planDist, countryDist, flagged, onViewAllFlagged }: OverviewSectionProps) {
  const flaggedColumns = [
    {
      key: 'login',
      header: 'Login',
      render: (a: DashboardAccount) => <span className="font-mono text-red-400 text-xs">{a.login}</span>,
    },
    {
      key: 'name',
      header: 'Name',
      render: (a: DashboardAccount) => (
        <span className="text-xs text-gray-300 whitespace-nowrap">
          {a.firstName && a.lastName ? `${a.firstName} ${a.lastName}` : a.email || '—'}
        </span>
      ),
    },
    {
      key: 'plan',
      header: 'Plan',
      render: (a: DashboardAccount) => <span className="text-xs text-gray-400">{a.plan || '—'}</span>,
    },
    {
      key: 'provider',
      header: 'Platform',
      render: (a: DashboardAccount) =>
        a.providerLabel ? (
          <span className="inline-flex items-center rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-gray-300">
            {a.providerLabel}
          </span>
        ) : (
          <span className="text-[10px] text-gray-600">—</span>
        ),
    },
    {
      key: 'payoutAmount',
      header: 'Payout',
      render: (a: DashboardAccount) => <span className="text-xs text-white font-semibold whitespace-nowrap">{formatCurrency(a.payoutAmount)}</span>,
    },
    {
      key: 'totalDeductions',
      header: 'Deductions',
      render: (a: DashboardAccount) => (
        <span className="text-xs text-red-400 font-semibold whitespace-nowrap">{formatCurrency(a.totalDeductions)}</span>
      ),
    },
    {
      key: 'violationLabels',
      header: 'Violations',
      render: (a: DashboardAccount) => (
        <div className="flex flex-wrap gap-1">
          {a.violationLabels.map((label, i) => (
            <Badge key={i} variant={SEVERITY_BADGE[a.severity] || 'red'} className="!text-[10px]">{label}</Badge>
          ))}
        </div>
      ),
    },
    {
      key: 'severity',
      header: 'Severity',
      render: (a: DashboardAccount) => (
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${SEVERITY_COLORS[a.severity]}`}>{a.severity}</span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SeverityDistributionCard distribution={severity} />
        <ViolationBreakdownCard data={violationBreakdown} />
      </div>

      <PlanCountryDistribution planDist={planDist} countryDist={countryDist} />

      {/* Top Flagged Preview */}
      {flagged.length > 0 && (
        <GlassCard padding="sm">
          <div className="flex items-center justify-between mb-3">
            <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              <AlertTriangle className="h-3 w-3" /> Top Flagged Accounts
            </h4>
            <button onClick={onViewAllFlagged} className="text-[11px] text-red-400 hover:text-red-300 transition-colors">
              View all &rarr;
            </button>
          </div>
          <DataTable columns={flaggedColumns} data={flagged.slice(0, 8)} onRowClick={onViewAllFlagged} />
        </GlassCard>
      )}
    </div>
  );
}
