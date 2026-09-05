'use client';

import { Badge } from '@/components/ui/badge';
import { formatCurrency, formatDate } from '@/lib/utils/format';
import type { PayoutHistoryRecord } from '@/types/history';

interface Props {
  records: PayoutHistoryRecord[];
  onRowClick: (record: PayoutHistoryRecord) => void;
  loading?: boolean;
}

export function HistoryTable({ records, onRowClick, loading }: Props) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded-lg border border-white/10 bg-white/5" />
        ))}
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 py-12 text-center text-sm text-gray-500">
        No payout history records found.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-white/10 bg-white/5">
            <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">Date Decided</th>
            <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">Login</th>
            <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">Name</th>
            <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">Plan</th>
            <th className="px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-400">Amount</th>
            <th className="px-3 py-2.5 text-center text-[10px] font-semibold uppercase tracking-wider text-gray-400">Decision</th>
            <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">Violations</th>
            <th className="px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-400">Deductions</th>
            <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">Decided By</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr
              key={r.id}
              onClick={() => onRowClick(r)}
              className="border-b border-white/5 hover:bg-white/5 cursor-pointer transition-colors"
            >
              <td className="px-3 py-2.5 text-gray-300">{r.decidedAt ? formatDate(r.decidedAt) : '—'}</td>
              <td className="px-3 py-2.5 font-mono text-white">{r.login || '—'}</td>
              <td className="px-3 py-2.5 text-gray-300 max-w-[120px] truncate">
                {r.firstName && r.lastName ? `${r.firstName} ${r.lastName}` : '—'}
              </td>
              <td className="px-3 py-2.5 text-gray-400 max-w-[120px] truncate">{r.plan || '—'}</td>
              <td className="px-3 py-2.5 text-right text-green-400 font-semibold">
                {formatCurrency(r.clientAmount || r.amount || 0)}
              </td>
              <td className="px-3 py-2.5 text-center">
                <Badge variant={r.decision === 'approved' ? 'green' : 'red'}>
                  {r.decision === 'approved' ? 'Approved' : 'Rejected'}
                </Badge>
              </td>
              <td className="px-3 py-2.5">
                <div className="flex flex-wrap gap-1 max-w-[180px]">
                  {r.violationsList.length > 0
                    ? r.violationsList.slice(0, 3).map((v) => (
                        <Badge key={v} variant="red" className="!text-[9px]">{v}</Badge>
                      ))
                    : <span className="text-gray-600">None</span>
                  }
                  {r.violationsList.length > 3 && (
                    <Badge variant="silver" className="!text-[9px]">+{r.violationsList.length - 3}</Badge>
                  )}
                </div>
              </td>
              <td className="px-3 py-2.5 text-right text-red-400">
                {r.deductionsTotal > 0 ? formatCurrency(r.deductionsTotal) : '—'}
              </td>
              <td className="px-3 py-2.5 text-gray-500 text-[10px]">{r.decidedBy || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
