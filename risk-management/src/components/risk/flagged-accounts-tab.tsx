import { Fragment } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { ExpandedPayout } from '@/components/payouts/expanded-payout';
import type { PayoutAnalysisResult } from '@/components/payouts/expanded-payout';
import { GlassCard } from '@/components/ui/glass-card';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/utils/format';
import type { DashboardAccount } from '@/hooks/use-platform-dashboard';
import { SEVERITY_BADGE, SEVERITY_COLORS } from './constants';
import { dashToPayoutRecord } from './dash-to-payout-record';

const FLAGGED_COL_SPAN = 8; // chevron + 7 data columns

interface FlaggedAccountsTabProps {
  flagged: DashboardAccount[];
  page: number;
  perPage: number;
  onPageChange: (page: number) => void;
  expandedId: string | null;
  analyzingId: string | null;
  analysisResults: Record<string, PayoutAnalysisResult>;
  onToggleExpand: (acct: DashboardAccount) => void;
}

/** "Flagged Accounts" tab on the funded-payouts risk dashboard. */
export function FlaggedAccountsTab({
  flagged, page, perPage, onPageChange,
  expandedId, analyzingId, analysisResults, onToggleExpand,
}: FlaggedAccountsTabProps) {
  const pageItems = flagged.slice((page - 1) * perPage, page * perPage);

  return (
    <div className="space-y-3">
      <div className="text-xs text-gray-500">
        {flagged.length} accounts with deductions, sorted by highest deduction amount.
      </div>
      <GlassCard padding="none">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/10">
              <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500 w-8"></th>
              <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Login</th>
              <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Name</th>
              <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Plan</th>
              <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Payout</th>
              <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Deductions</th>
              <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Violations</th>
              <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Severity</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.length === 0 && (
              <tr><td colSpan={FLAGGED_COL_SPAN} className="px-4 py-8 text-center text-xs text-gray-500">No flagged accounts</td></tr>
            )}
            {pageItems.map((acct) => {
              const isExpanded = expandedId === acct.accountId;
              const isAnalyzing = analyzingId === acct.accountId;
              const result = analysisResults[acct.accountId];
              return (
                <Fragment key={acct.accountId}>
                  <tr className="border-b border-white/5 hover:bg-white/[0.03] cursor-pointer transition-colors" onClick={() => onToggleExpand(acct)}>
                    <td className="px-3 py-2.5">{isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-gray-500" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-500" />}</td>
                    <td className="px-3 py-2.5"><span className="font-mono text-red-400 text-xs">{acct.login}</span></td>
                    <td className="px-3 py-2.5"><span className="text-xs text-gray-300 whitespace-nowrap">{acct.firstName && acct.lastName ? `${acct.firstName} ${acct.lastName}` : acct.email || '—'}</span></td>
                    <td className="px-3 py-2.5"><span className="text-xs text-gray-400">{acct.plan || '—'}</span></td>
                    <td className="px-3 py-2.5"><span className="text-xs text-white font-semibold whitespace-nowrap">{formatCurrency(acct.payoutAmount)}</span></td>
                    <td className="px-3 py-2.5"><span className="text-xs text-red-400 font-semibold whitespace-nowrap">{formatCurrency(acct.totalDeductions)}</span></td>
                    <td className="px-3 py-2.5"><div className="flex flex-wrap gap-1">{acct.violationLabels.map((label, i) => <Badge key={i} variant={SEVERITY_BADGE[acct.severity] || 'red'} className="!text-[10px]">{label}</Badge>)}</div></td>
                    <td className="px-3 py-2.5"><span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${SEVERITY_COLORS[acct.severity]}`}>{acct.severity}</span></td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={FLAGGED_COL_SPAN} className="p-0">
                        {isAnalyzing && !result ? (
                          <div className="flex items-center justify-center gap-2 py-8 text-gray-400"><Loader2 className="h-4 w-4 animate-spin" /><span className="text-xs">Analyzing trades...</span></div>
                        ) : (
                          <ExpandedPayout record={dashToPayoutRecord(acct)} analysis={result || null} analyzing={isAnalyzing} onStatusChange={() => {}} onNotesChange={() => {}} />
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {flagged.length > perPage && (
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/10">
            <span className="text-[10px] text-gray-500">Page {page} of {Math.ceil(flagged.length / perPage)} ({flagged.length} total)</span>
            <div className="flex gap-2">
              <button onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page === 1} className="px-2.5 py-1 text-[10px] rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30">Previous</button>
              <button onClick={() => onPageChange(Math.min(Math.ceil(flagged.length / perPage), page + 1))} disabled={page >= Math.ceil(flagged.length / perPage)} className="px-2.5 py-1 text-[10px] rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30">Next</button>
            </div>
          </div>
        )}
      </GlassCard>
    </div>
  );
}
