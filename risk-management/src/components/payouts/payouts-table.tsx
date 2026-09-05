'use client';

import { Fragment, useState, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Copy, Check, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { formatCurrency, formatDateTime } from '@/lib/utils/format';
import { ExpandedPayout } from './expanded-payout';
import type { PayoutAnalysisResult } from './expanded-payout';
import type { PayoutRecord, PayoutStatus } from '@/types/payouts';

function CopyableCell({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);

  return (
    <button onClick={handleCopy} className="inline-flex items-center gap-1 font-mono text-xs text-white font-medium whitespace-nowrap hover:text-red-400 transition-colors" title="Click to copy">
      {value}
      {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3 text-gray-500" />}
    </button>
  );
}

function preApprovalBadge(status?: number) {
  if (status === 1) return <Badge variant="green">Pre-Approved</Badge>;
  if (status === -1) return <Badge variant="red">Not Pre-Approved</Badge>;
  return <Badge variant="yellow">Not Reviewed</Badge>;
}

const VIOLATION_LABEL: Record<string, string> = {
  overleveraging: 'Overleveraging',
  hft: 'HFT',
  martingale: 'Martingale',
  news: 'News Trading',
  grid: 'Grid Trading',
  copy: 'Copy Trading',
  violations: 'Violations',
  overnight: 'Overnight',
};

const COL_SPAN = 10; // chevron + 9 data columns

interface PayoutsTableProps {
  records: PayoutRecord[];
  loading?: boolean;
  onStatusChange: (id: string, status: PayoutStatus) => void;
  onNotesChange: (id: string, notes: string) => void;
  onPreApproval?: (id: string, status: number, note?: string) => void;
  onFinalAction?: (id: string, action: 'approve' | 'reject', note?: string) => void;
}

export function PayoutsTable({ records, loading, onStatusChange, onNotesChange, onPreApproval, onFinalAction }: PayoutsTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [analysisResults, setAnalysisResults] = useState<Record<string, PayoutAnalysisResult>>({});
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);

  const analyzeAccount = useCallback(async (record: PayoutRecord) => {
    const id = record.accountId || record.id;
    if (analysisResults[id]) return; // already cached
    setAnalyzingId(id);
    try {
      const res = await fetch(`/api/payouts/${record.accountId}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: record.email }),
      });
      if (res.ok) {
        const json = await res.json();
        setAnalysisResults((prev) => ({ ...prev, [id]: json.data }));
      }
    } catch { /* noop */ }
    finally { setAnalyzingId(null); }
  }, [analysisResults]);

  const toggleExpand = useCallback((record: PayoutRecord) => {
    const id = record.accountId || record.id;
    if (expandedId === id) {
      setExpandedId(null);
    } else {
      setExpandedId(id);
      if (!analysisResults[id]) {
        analyzeAccount(record);
      }
    }
  }, [expandedId, analysisResults, analyzeAccount]);

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded-lg border border-white/10 bg-white/5" />
        ))}
      </div>
    );
  }

  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-white/10">
          <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500 w-8"></th>
          <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Date & Time</th>
          <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Login</th>
          <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Payout</th>
          <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Plan</th>
          <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Country</th>
          <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">KYC</th>
          <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Deductions</th>
          <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Violations</th>
          <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Pre-Approval</th>
        </tr>
      </thead>
      <tbody>
        {records.length === 0 && (
          <tr>
            <td colSpan={COL_SPAN} className="px-4 py-8 text-center text-xs text-gray-500">
              No pending payouts found.
            </td>
          </tr>
        )}
        {records.map((r) => {
          const id = r.accountId || r.id;
          const isExpanded = expandedId === id;
          const isAnalyzing = analyzingId === id;
          const result = analysisResults[id];

          return (
            <Fragment key={r.id || r._id || id}>
              <tr
                className="border-b border-white/5 hover:bg-white/[0.03] cursor-pointer transition-colors"
                onClick={() => toggleExpand(r)}
              >
                <td className="px-3 py-2.5">
                  {isExpanded
                    ? <ChevronDown className="h-3.5 w-3.5 text-gray-500" />
                    : <ChevronRight className="h-3.5 w-3.5 text-gray-500" />}
                </td>
                <td className="px-3 py-2.5">
                  <span className="text-xs text-gray-400 whitespace-nowrap">
                    {r.dateRequested ? formatDateTime(r.dateRequested) : '—'}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  {r.login ? <CopyableCell value={r.login} /> : <span className="text-xs text-gray-500">—</span>}
                </td>
                <td className="px-3 py-2.5">
                  <span className="font-semibold text-xs text-green-400 whitespace-nowrap">
                    {formatCurrency(r.clientAmount ?? r.amount ?? 0)}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <span className="text-xs text-gray-300 whitespace-nowrap">{r.plan || '—'}</span>
                </td>
                <td className="px-3 py-2.5">
                  <span className="text-xs text-gray-400 whitespace-nowrap">{r.kycCountry || r.country || '—'}</span>
                </td>
                <td className="px-3 py-2.5">
                  <Badge variant={r.kycStatus === 'Verified' || r.kycStatus === 'COMPLETED' ? 'green' : r.kycStatus === 'Unknown' ? 'silver' : 'yellow'}>
                    {r.kycStatus === 'COMPLETED' ? 'Verified' : r.kycStatus || '—'}
                  </Badge>
                </td>
                <td className="px-3 py-2.5">
                  {r.platformDeductions?.totalDeductions
                    ? <span className="text-red-400 font-semibold text-xs whitespace-nowrap">{formatCurrency(r.platformDeductions.totalDeductions)}</span>
                    : <span className="text-xs text-gray-500">—</span>}
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-0.5">
                    {r.platformViolations.length > 0
                      ? r.platformViolations.map((v) => <Badge key={v} variant="red">{VIOLATION_LABEL[v] || v}</Badge>)
                      : <span className="text-xs text-gray-500">—</span>}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  {preApprovalBadge(r.preApprovedStatus)}
                </td>
              </tr>
              {isExpanded && (
                <tr>
                  <td colSpan={COL_SPAN} className="p-0">
                    {isAnalyzing && !result ? (
                      <div className="flex items-center justify-center gap-2 py-8 text-gray-400">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span className="text-xs">Analyzing trades...</span>
                      </div>
                    ) : (
                      <ExpandedPayout
                        record={r}
                        analysis={result || null}
                        analyzing={isAnalyzing}
                        onStatusChange={onStatusChange}
                        onNotesChange={onNotesChange}
                        onPreApproval={onPreApproval}
                        onFinalAction={onFinalAction}
                      />
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
