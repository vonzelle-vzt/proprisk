'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Shield, User, AlertTriangle, DollarSign, BarChart3, RefreshCw, TrendingUp, Clock, Activity, FileWarning, Download, X, Eye } from 'lucide-react';
import { format } from 'date-fns';
import { GlassCard } from '@/components/ui/glass-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Modal } from '@/components/ui/modal';
import { Tabs } from '@/components/ui/tabs';
import { ReportDownloadButtons } from '@/components/violations/report-download-buttons';
import { formatCurrency, formatDateTime } from '@/lib/utils/format';

const BADGE_VARIANT: Record<string, 'red' | 'yellow' | 'blue' | 'purple' | 'green' | 'silver'> = {
  overleveraging: 'yellow', hft: 'blue',
  martingale: 'purple', news: 'green', grid: 'silver', copy: 'red',
  violations: 'red', overnight: 'yellow',
};

const TYPE_KEY_TO_LABEL: Record<string, string> = {
  hft: 'High Frequency Trading',
  martingale: 'Martingale',
  overleveraging: 'Over Leverage',
  news: 'News Trading',
  grid: 'Grid Trading',
  copy: 'Copy Trading',
  overnight: 'Overnight',
};

const VIOLATION_TYPE_DESCRIPTIONS: Record<string, string> = {
  hft: 'High Frequency Trading (HFT) violations are flagged when trades are held for less than 1 minute. If 5 or more trades meet this criteria, all sub-minute trades are flagged and their profits are deducted. This rule prevents latency arbitrage and tick-scalping strategies.',
  martingale: 'Martingale violations occur when a trader increases lot size by more than 1.5x after consecutive losses, indicating a doubling-down strategy. The escalated trade\'s profit is deducted. This rule prevents unsustainable risk compounding.',
  overleveraging: 'Over Leverage violations are flagged when a trade\'s lot size exceeds 3x the account\'s average lot size. If 3 or more trades meet this criteria, all overleveraged trade profits are deducted. This rule prevents excessive position sizing.',
  news: 'News Trading violations occur when trades are opened within 5 minutes before or after the hour (common high-impact news release windows) and held for less than 30 minutes. If 3 or more trades match, all news-window trade profits are deducted. This rule prevents news-spike exploitation.',
  grid: 'Grid Trading violations are detected when 5 or more trades on the same instrument are placed at regular price intervals (60%+ uniformity). All grid trade profits are deducted. This rule prevents automated grid strategies.',
  copy: 'Copy Trading violations are flagged when trade patterns closely mirror another account — matching symbols, similar timing (within 60 seconds), and near-identical lot sizes (within 10% tolerance). If 5 or more copied trades are detected with a 70%+ similarity score, all copied trade profits are deducted.',
  overnight: 'Overnight violations are flagged when positions are held through the market close/open session, exposing the account to gap risk. Profits from overnight-held positions may be deducted depending on the account plan rules.',
};

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[11px] text-gray-500 shrink-0">{label}</span>
      <span className="text-xs text-gray-200">{children}</span>
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-center">
      <div className={`text-sm font-bold ${color || 'text-white'}`}>{value}</div>
      <div className="text-[9px] text-gray-500 uppercase tracking-wider mt-0.5">{label}</div>
    </div>
  );
}

/* ----- Violation Trades Modal ----- */
function ViolationTradesModal({
  typeKey,
  typeLabel,
  trades,
  accountId,
  onClose,
  providerOnly,
  providerAmount,
}: {
  typeKey: string;
  typeLabel: string;
  trades: any[];
  accountId: string;
  onClose: () => void;
  providerOnly?: boolean;
  providerAmount?: number;
}) {
  const totalDeduction = providerOnly ? (providerAmount || 0) : trades.reduce((s: number, t: any) => s + (t.deductionAmount || 0), 0);
  const totalProfit = trades.reduce((s: number, t: any) => s + (t.profit || 0), 0);
  const symbols = [...new Set(trades.map((t: any) => t.symbol || t.stdSymbol || t.trdSymbol))];

  const exportViolationCsv = () => {
    if (trades.length === 0) return;
    const headers = ['Symbol', 'Side', 'Lots', 'Open Time', 'Close Time', 'Duration (h)', 'Open Price', 'Close Price', 'P&L', 'Commission', 'Swap', 'Total Deduction', 'News Impact', 'News Event', 'Explanation'];
    const rows = trades.map((t: any) => [
      t.symbol || t.stdSymbol || t.trdSymbol, t.side, t.lots?.toFixed(2) || '',
      formatDateTime(t.openTime), formatDateTime(t.closeTime),
      (t.duration || 0).toFixed(2), t.openPrice, t.closePrice,
      (t.profit || 0).toFixed(2), (t.commission || 0).toFixed(2), (t.swap || 0).toFixed(2),
      (t.deductionAmount ?? 0).toFixed(2),
      t.newsImpact || '', t.newsEvent || '', t.explanation || t.comment || (t.reason ? (t.reason as string).replace('CLOSE_REASON_', '') : ''),
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${typeKey}_violations_${accountId}_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-4xl max-h-[85vh] overflow-hidden rounded-2xl border border-white/15 bg-[#0d0d0f]/95 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <Badge variant={BADGE_VARIANT[typeKey] || 'red'}>{typeLabel}</Badge>
            <h3 className="text-sm font-semibold text-white">Violation Trade Details</h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={exportViolationCsv}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 transition-colors">
              <X className="h-4 w-4 text-gray-400" />
            </button>
          </div>
        </div>

        {/* Violation type explanation */}
        {VIOLATION_TYPE_DESCRIPTIONS[typeKey] && (
          <div className="px-5 py-3 border-b border-white/5 bg-white/[0.01]">
            <p className="text-[11px] text-gray-400 leading-relaxed">{VIOLATION_TYPE_DESCRIPTIONS[typeKey]}</p>
          </div>
        )}

        {/* platform-only banner */}
        {providerOnly && (
          <div className="flex items-start gap-2 px-5 py-3 border-b border-yellow-500/20 bg-yellow-500/5">
            <AlertTriangle className="h-3.5 w-3.5 text-yellow-400 mt-0.5 shrink-0" />
            <p className="text-[11px] text-yellow-300/80 leading-relaxed">
              This violation was reported by the Trading Platform ({formatCurrency(providerAmount || 0)} deduction) but our analysis engine did not flag specific trades.
              All account trades are shown below for manual review.
            </p>
          </div>
        )}

        {/* Summary bar */}
        <div className="flex items-center gap-6 px-5 py-3 border-b border-white/5 bg-white/[0.02]">
          <div className="text-xs">
            <span className="text-gray-500">{providerOnly ? 'All Trades:' : 'Trades:'}</span>{' '}
            <span className="text-white font-semibold">{trades.length}</span>
          </div>
          <div className="text-xs">
            <span className="text-gray-500">Instruments:</span>{' '}
            <span className="text-white font-semibold">{symbols.join(', ')}</span>
          </div>
          <div className="text-xs">
            <span className="text-gray-500">Total P&L:</span>{' '}
            <span className={`font-semibold ${totalProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {formatCurrency(totalProfit)}
            </span>
          </div>
          <div className="text-xs ml-auto">
            <span className="text-gray-500">Total Deduction:</span>{' '}
            <span className="text-red-400 font-bold">{formatCurrency(totalDeduction)}</span>
          </div>
        </div>

        {/* Trade list */}
        <div className="flex-1 overflow-auto px-5 py-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-white/10">
                <th className="text-left py-2 text-[10px] text-gray-500 font-semibold uppercase">Symbol</th>
                <th className="text-left py-2 text-[10px] text-gray-500 font-semibold uppercase">Side</th>
                <th className="text-left py-2 text-[10px] text-gray-500 font-semibold uppercase">Lots</th>
                <th className="text-left py-2 text-[10px] text-gray-500 font-semibold uppercase">Open Time</th>
                <th className="text-left py-2 text-[10px] text-gray-500 font-semibold uppercase">Duration</th>
                <th className="text-left py-2 text-[10px] text-gray-500 font-semibold uppercase">Open / Close</th>
                <th className="text-right py-2 text-[10px] text-gray-500 font-semibold uppercase">P&L</th>
                <th className="text-right py-2 text-[10px] text-gray-500 font-semibold uppercase">Deduction</th>
                <th className="text-left py-2 text-[10px] text-gray-500 font-semibold uppercase pl-3">Details</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t: any, i: number) => {
                const hrs = t.duration || 0;
                const durLabel = hrs < 1 ? `${Math.round(hrs * 60)}m` : `${hrs.toFixed(1)}h`;
                return (
                  <tr key={t.tradeId || i} className="border-b border-white/5 hover:bg-white/[0.03] transition-colors">
                    <td className="py-2">
                      <span className="text-white font-semibold">{t.symbol || t.stdSymbol || t.trdSymbol}</span>
                    </td>
                    <td className="py-2 text-gray-400">{t.side}</td>
                    <td className="py-2 text-gray-400">{t.lots?.toFixed(2)}</td>
                    <td className="py-2 text-gray-400 whitespace-nowrap">{formatDateTime(t.openTime)}</td>
                    <td className="py-2 text-gray-400">{durLabel}</td>
                    <td className="py-2 text-gray-300 whitespace-nowrap">{t.openPrice} → {t.closePrice}</td>
                    <td className={`py-2 text-right font-semibold whitespace-nowrap ${t.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {formatCurrency(t.profit)}
                    </td>
                    <td className="py-2 text-right text-red-400 font-semibold whitespace-nowrap">
                      {formatCurrency(t.deductionAmount ?? 0)}
                    </td>
                    <td className="py-2 pl-3">
                      <span className="text-gray-500 whitespace-normal break-words">
                        {t.explanation || t.comment || (t.reason ? (t.reason as string).replace('CLOSE_REASON_', '') : '')}
                      </span>
                      {t.newsEvent && (
                        <div className="flex items-center gap-1 mt-0.5">
                          <Badge variant={t.newsImpact === 'High' ? 'red' : 'yellow'}>{t.newsImpact}</Badge>
                          <span className="text-[9px] text-yellow-400">{t.newsEvent}</span>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function ProviderViolationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const accountId = params.accountId as string;
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [tradePage, setTradePage] = useState(1);
  const tradePerPage = 20;
  const [modalTypeKey, setModalTypeKey] = useState<string | null>(null);
  const [internalModalOpen, setInternalModalOpen] = useState(false);
  const [internalModalPage, setInternalModalPage] = useState(1);
  const modalPerPage = 10;
  const [recheckingNews, setRecheckingNews] = useState(false);

  const fetchData = useCallback(async (recheckNews = false) => {
    setLoading(true);
    setError(null);
    try {
      const url = recheckNews
        ? `/api/platform/violations/${accountId}?recheckNews=true`
        : `/api/platform/violations/${accountId}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
      setRecheckingNews(false);
    }
  }, [accountId]);

  const handleRecheckNews = useCallback(() => {
    setRecheckingNews(true);
    fetchData(true);
  }, [fetchData]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        <RefreshCw className="h-5 w-5 animate-spin mr-2" />
        Loading account details, trades, and violations...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => router.push('/violations')}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back to Violations
        </Button>
        <div className="flex items-center justify-center h-48 text-red-400">{error || 'Violation data not found'}</div>
      </div>
    );
  }

  const stats = data.tradeStats;
  const trades = data.trades || [];
  const flaggedTrades = data.flaggedTrades || [];
  const analysisSummary = data.tradeAnalysisSummary;

  // Group flagged trades by violation typeKey for modals and breakdown
  const flaggedByTypeKey: Record<string, any[]> = {};
  for (const ft of flaggedTrades) {
    (flaggedByTypeKey[ft.type] ||= []).push(ft);
  }

  // Group flagged trades by violation type label for the flagged tab
  const flaggedByType: Record<string, any[]> = {};
  for (const ft of flaggedTrades) {
    (flaggedByType[ft.typeLabel] ||= []).push(ft);
  }

  // The calculated total deductions (per unique trade, no double counting) is the authoritative number
  const calculatedTotal = analysisSummary?.totalDeductions || 0;
  const providerTotal = data.totalDeductions || 0;
  // Use the higher of the two as the recommended deduction
  const recommendedDeduction = Math.max(calculatedTotal, providerTotal);

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'flagged', label: 'Flagged Trades', count: flaggedTrades.length },
    { id: 'trades', label: 'All Trades', count: data.tradeTotal || trades.length },
    { id: 'stats', label: 'Statistics' },
  ];

  const flaggedColumns = [
    {
      key: 'symbol',
      header: 'Symbol',
      render: (t: any) => (
        <div className="min-w-0">
          <span className="text-[11px] font-semibold text-white">{t.symbol}</span>
          <span className="block text-[9px] text-gray-500">{t.side} {t.lots?.toFixed(2)} lots</span>
        </div>
      ),
    },
    {
      key: 'openTime',
      header: 'Open',
      render: (t: any) => <span className="text-[10px] text-gray-400 whitespace-nowrap">{formatDateTime(t.openTime)}</span>,
    },
    {
      key: 'duration',
      header: 'Dur.',
      render: (t: any) => {
        const hrs = t.duration || 0;
        if (hrs < 1) return <span className="text-[10px] text-gray-400">{Math.round(hrs * 60)}m</span>;
        return <span className="text-[10px] text-gray-400">{hrs.toFixed(1)}h</span>;
      },
    },
    {
      key: 'prices',
      header: 'Open / Close',
      render: (t: any) => (
        <span className="text-[10px] text-gray-300 whitespace-nowrap">{t.openPrice} → {t.closePrice}</span>
      ),
    },
    {
      key: 'profit',
      header: 'P&L',
      render: (t: any) => (
        <span className={`text-[11px] font-semibold whitespace-nowrap ${t.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {formatCurrency(t.profit)}
        </span>
      ),
    },
    {
      key: 'deductionAmount',
      header: 'Total Deduction',
      render: (t: any) => (
        <span className="text-[11px] text-red-400 font-semibold whitespace-nowrap">{formatCurrency(t.deductionAmount ?? 0)}</span>
      ),
    },
    {
      key: 'explanation',
      header: 'Details',
      render: (t: any) => (
        <div className="min-w-[200px]">
          <span className="text-[10px] text-gray-400 whitespace-normal break-words">{t.explanation}</span>
          {t.newsEvent && (
            <div className="flex items-center gap-1 mt-0.5">
              <Badge variant={t.newsImpact === 'High' ? 'red' : 'yellow'}>{t.newsImpact}</Badge>
              <span className="text-[9px] text-yellow-400 font-medium whitespace-normal break-words">{t.newsEvent}</span>
            </div>
          )}
        </div>
      ),
    },
  ];

  const tradeColumns = [
    {
      key: 'closeTime',
      header: 'Close',
      render: (t: any) => <span className="text-[10px] text-gray-400 whitespace-nowrap">{formatDateTime(t.closeTime)}</span>,
    },
    {
      key: 'stdSymbol',
      header: 'Symbol',
      render: (t: any) => (
        <div className="min-w-0">
          <span className="text-[11px] font-semibold text-white">{t.stdSymbol || t.trdSymbol}</span>
          <span className="block text-[9px] text-gray-500">{t.side} {t.lots?.toFixed(2)} lots</span>
        </div>
      ),
    },
    {
      key: 'prices',
      header: 'Open / Close',
      render: (t: any) => <span className="text-[10px] text-gray-300 whitespace-nowrap">{t.openPrice} → {t.closePrice}</span>,
    },
    {
      key: 'duration',
      header: 'Dur.',
      render: (t: any) => {
        const hrs = t.duration || 0;
        if (hrs < 1) return <span className="text-[10px] text-gray-400">{Math.round(hrs * 60)}m</span>;
        return <span className="text-[10px] text-gray-400">{hrs.toFixed(1)}h</span>;
      },
    },
    {
      key: 'profit',
      header: 'P&L',
      render: (t: any) => (
        <span className={`text-[11px] font-semibold whitespace-nowrap ${t.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {formatCurrency(t.profit)}
        </span>
      ),
    },
    {
      key: 'commission',
      header: 'Comm.',
      render: (t: any) => <span className="text-[10px] text-gray-500 whitespace-nowrap">{formatCurrency(t.commission || 0)}</span>,
    },
    {
      key: 'sltp',
      header: 'SL / TP',
      render: (t: any) => <span className="text-[10px] text-gray-500 whitespace-nowrap">{t.stopLoss || '—'} / {t.takeProfit || '—'}</span>,
    },
    {
      key: 'reason',
      header: 'Reason',
      render: (t: any) => <span className="text-[10px] text-gray-500">{(t.reason || '').replace('CLOSE_REASON_', '')}</span>,
    },
  ];

  const exportCsv = (rows: string[][], headers: string[], filename: string) => {
    const csv = [headers.join(','), ...rows.map((r) => r.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const exportFlaggedTrades = () => {
    if (flaggedTrades.length === 0) return;
    const headers = ['Symbol', 'Side', 'Lots', 'Open Time', 'Duration (h)', 'Open Price', 'Close Price', 'P&L', 'Total Deduction', 'Type', 'News Impact', 'News Event', 'Explanation'];
    const rows = flaggedTrades.map((t: any) => [
      t.symbol, t.side, t.lots?.toFixed(2) || '', formatDateTime(t.openTime),
      (t.duration || 0).toFixed(2), t.openPrice, t.closePrice,
      (t.profit || 0).toFixed(2), (t.deductionAmount ?? 0).toFixed(2),
      t.typeLabel || '', t.newsImpact || '', t.newsEvent || '', t.explanation || '',
    ]);
    exportCsv(rows, headers, `flagged_trades_${accountId}_${format(new Date(), 'yyyy-MM-dd')}.csv`);
  };

  const exportAllTrades = () => {
    if (trades.length === 0) return;
    const headers = ['Close Time', 'Symbol', 'Side', 'Lots', 'Open Price', 'Close Price', 'Duration (h)', 'P&L', 'Commission', 'Swap', 'SL', 'TP', 'Reason'];
    const rows = trades.map((t: any) => [
      formatDateTime(t.closeTime), t.stdSymbol || t.trdSymbol, t.side, t.lots?.toFixed(2) || '',
      t.openPrice, t.closePrice, (t.duration || 0).toFixed(2),
      (t.profit || 0).toFixed(2), (t.commission || 0).toFixed(2), (t.swap || 0).toFixed(2),
      t.stopLoss || '', t.takeProfit || '', (t.reason || '').replace('CLOSE_REASON_', ''),
    ]);
    exportCsv(rows, headers, `all_trades_${accountId}_${format(new Date(), 'yyyy-MM-dd')}.csv`);
  };

  /**
   * Every decision record on this account, as one CSV.
   *
   * Unlike the two exports above (which serialize what is already on screen),
   * this one asks the SERVER for the persisted reports — the account endpoint
   * builds any that do not exist yet and reports how many it built in
   * `X-Reports-Built`. A client-side serialization could not do that, and an
   * export that quietly omitted the violations nobody had downloaded yet
   * would be worse than no export.
   */
  const exportAllViolationReports = () => {
    const link = document.createElement('a');
    link.href = `/api/violations/account/${encodeURIComponent(accountId)}/report`;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Modal data — fall back to all trades for platform-only violations
  const isProviderOnly = modalTypeKey ? !flaggedByTypeKey[modalTypeKey] : false;
  const modalTrades = modalTypeKey ? (flaggedByTypeKey[modalTypeKey] || trades) : [];
  const modalLabel = modalTypeKey ? (TYPE_KEY_TO_LABEL[modalTypeKey] || modalTypeKey) : '';
  const providerViolation = modalTypeKey ? data.violationBreakdown?.find((v: any) => v.type === modalTypeKey) : null;

  return (
    <div className="space-y-5">
      {/* Violation Type Modal */}
      {modalTypeKey && (
        <ViolationTradesModal
          typeKey={modalTypeKey}
          typeLabel={modalLabel}
          trades={modalTrades}
          accountId={accountId}
          onClose={() => setModalTypeKey(null)}
          providerOnly={isProviderOnly}
          providerAmount={providerViolation?.amount}
        />
      )}

      {/* Internal Analysis Detail Modal */}
      <Modal isOpen={internalModalOpen} onClose={() => setInternalModalOpen(false)} title="Internal Analysis — Detail" size="lg">
        <div className="space-y-4">
          <div className="flex items-start justify-between">
            <div className="grid grid-cols-3 gap-3 flex-1">
              <div className="text-center">
                <span className="block text-[10px] text-gray-500 uppercase tracking-wider">Internal Total</span>
                <span className="text-sm font-bold text-red-400">{formatCurrency(calculatedTotal)}</span>
              </div>
              <div className="text-center">
                <span className="block text-[10px] text-gray-500 uppercase tracking-wider">Flagged Trades</span>
                <span className="text-sm font-bold text-white">{flaggedTrades.length}</span>
              </div>
              <div className="text-center">
                <span className="block text-[10px] text-gray-500 uppercase tracking-wider">Violation Types</span>
                <span className="text-sm font-bold text-white">{Object.keys(flaggedByTypeKey).length}</span>
              </div>
            </div>
            {flaggedTrades.length > 0 && (
              <button
                onClick={() => {
                  const headers = ['Symbol', 'Type', 'Side', 'Lots', 'P&L', 'Deduction', 'Explanation'];
                  const rows = flaggedTrades.map((t: any) => [t.symbol, t.typeLabel, t.side, t.lots?.toFixed(2) || '', (t.profit || 0).toFixed(2), (t.deductionAmount ?? 0).toFixed(2), t.explanation || '']);
                  exportCsv(rows, headers, `internal_analysis_${accountId}_${format(new Date(), 'yyyy-MM-dd')}.csv`);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 hover:text-white transition-colors shrink-0"
              >
                <Download className="h-3.5 w-3.5" /> Export CSV
              </button>
            )}
          </div>

          {Object.keys(flaggedByTypeKey).length > 0 ? (
            <>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Deductions by Violation Type</h4>
              {Object.entries(analysisSummary?.deductionsByType || {}).filter(([k]) => k !== 'profit_cap' && k !== '2_percent_cap').map(([typeKey, amount]: [string, any]) => (
                <div key={typeKey} className="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Badge variant={BADGE_VARIANT[typeKey] || 'red'}>{TYPE_KEY_TO_LABEL[typeKey] || typeKey}</Badge>
                    <span className="text-xs text-gray-400">{analysisSummary?.violationTypeCount?.[typeKey] || 0} trades</span>
                  </div>
                  <span className="text-red-400 font-bold text-sm">{formatCurrency(amount)}</span>
                </div>
              ))}

              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 pt-2">Flagged Trades</h4>
              <DataTable
                columns={[
                  { key: 'symbol', header: 'Symbol', render: (t: any) => <span className="text-white text-[11px] font-semibold">{t.symbol}</span> },
                  { key: 'type', header: 'Type', render: (t: any) => <Badge variant={BADGE_VARIANT[t.type] || 'red'}>{t.typeLabel}</Badge> },
                  { key: 'side', header: 'Side/Lots', render: (t: any) => <span className="text-gray-400 text-[11px]">{t.side} {t.lots?.toFixed(2)}</span> },
                  { key: 'profit', header: 'P&L', render: (t: any) => <span className={`text-[11px] font-semibold ${t.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{formatCurrency(t.profit)}</span> },
                  { key: 'deductionAmount', header: 'Deduction', render: (t: any) => <span className="text-red-400 font-semibold text-[11px]">{formatCurrency(t.deductionAmount ?? 0)}</span> },
                  { key: 'explanation', header: 'Details', render: (t: any) => <span className="text-gray-500 text-[10px] line-clamp-2 max-w-[200px] block">{t.explanation}</span> },
                ]}
                data={flaggedTrades.slice((internalModalPage - 1) * modalPerPage, internalModalPage * modalPerPage)}
                emptyMessage="No flagged trades"
              />
              {flaggedTrades.length > modalPerPage && (
                <div className="flex items-center justify-between pt-2">
                  <span className="text-[10px] text-gray-500">Page {internalModalPage} of {Math.ceil(flaggedTrades.length / modalPerPage)} ({flaggedTrades.length} total)</span>
                  <div className="flex gap-2">
                    <button onClick={() => setInternalModalPage(Math.max(1, internalModalPage - 1))} disabled={internalModalPage === 1} className="px-2.5 py-1 text-[10px] rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30">Previous</button>
                    <button onClick={() => setInternalModalPage(Math.min(Math.ceil(flaggedTrades.length / modalPerPage), internalModalPage + 1))} disabled={internalModalPage >= Math.ceil(flaggedTrades.length / modalPerPage)} className="px-2.5 py-1 text-[10px] rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30">Next</button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-8 text-gray-500">
              <FileWarning className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No violations detected by internal analysis for this account.</p>
            </div>
          )}
        </div>
      </Modal>


      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => router.push('/violations')}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <div>
          <h2 className="text-lg font-semibold text-white">
            Violation Report — <span className="font-mono text-red-400">{data.login || accountId}</span>
          </h2>
          <p className="text-xs text-gray-500">Account {accountId} &bull; {data.plan || 'Unknown Plan'} &bull; {data.tradeTotal || trades.length} trades</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={exportAllViolationReports}
            title="Every decision record on this account as one CSV — built on demand for any violation that does not have one yet."
          >
            <Download className="h-3 w-3 mr-1" /> Export all (CSV)
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRecheckNews}
            disabled={recheckingNews || loading}
          >
            <RefreshCw className={`h-3 w-3 mr-1 ${recheckingNews ? 'animate-spin' : ''}`} />
            {recheckingNews ? 'Rechecking...' : 'Recheck News'}
          </Button>
          {recommendedDeduction > 0 && (
            <Badge variant="red">{formatCurrency(recommendedDeduction)} total deductions</Badge>
          )}
        </div>
      </div>

      <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

      {/* === OVERVIEW TAB === */}
      {activeTab === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <GlassCard padding="sm">
              <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                <Shield className="h-3 w-3" /> Account Information
              </h4>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                <InfoRow label="Login:"><span className="font-mono text-red-400">{data.login || '—'}</span></InfoRow>
                <InfoRow label="Account:"><span className="font-mono">{data.accountId}</span></InfoRow>
                <InfoRow label="Email:">{data.email || '—'}</InfoRow>
                <InfoRow label="Name:">{data.firstName && data.lastName ? `${data.firstName} ${data.lastName}` : '—'}</InfoRow>
                <InfoRow label="Plan:">{data.plan || '—'}</InfoRow>
                <InfoRow label="Country:">{data.country || '—'}</InfoRow>
              </div>
            </GlassCard>

            <GlassCard padding="sm">
              <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                <User className="h-3 w-3" /> KYC & User
              </h4>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                <InfoRow label="KYC:"><Badge variant={data.kycStatus === 'Verified' ? 'green' : 'yellow'}>{data.kycStatus}</Badge></InfoRow>
                <InfoRow label="Blacklisted:"><span className={data.isBlackListed ? 'text-red-400 font-semibold' : 'text-green-400'}>{data.isBlackListed ? 'YES' : 'No'}</span></InfoRow>
                <InfoRow label="Traded Days:">{data.tradedDays}</InfoRow>
                <InfoRow label="Approved Payouts:">{data.numApprovedPayouts} ({formatCurrency(data.approvedPayouts)})</InfoRow>
              </div>
              {(data.banNewsTrading || data.banHFT || data.banMTGL) && (
                <div className="mt-2">
                  <span className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Trading Restrictions</span>
                  <div className="flex gap-1">
                    {data.banNewsTrading && <Badge variant="yellow">News Trading Restricted</Badge>}
                    {data.banHFT && <Badge variant="yellow">HFT Restricted</Badge>}
                    {data.banMTGL && <Badge variant="yellow">Martingale Restricted</Badge>}
                  </div>
                </div>
              )}
            </GlassCard>
          </div>

          <GlassCard padding="sm">
            <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              <BarChart3 className="h-3 w-3" /> Account Metrics
            </h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1.5">
              <InfoRow label="Starting Balance:">{formatCurrency(data.startingBalance)}</InfoRow>
              <InfoRow label="Current Balance:">{formatCurrency(data.balance)}</InfoRow>
              <InfoRow label="Closed P&L:">
                {(() => {
                  const val = data.accountMetrics?.closedPnL ?? stats?.totals?.totalPnL ?? null;
                  return val != null
                    ? <span className={val >= 0 ? 'text-green-400' : 'text-red-400'}>{formatCurrency(val)}</span>
                    : <span className="text-gray-500">—</span>;
                })()}
              </InfoRow>
              <InfoRow label="Total P&L:">
                {(() => {
                  const val = data.accountMetrics?.totalPnL ?? stats?.totals?.totalPnL ?? null;
                  return val != null
                    ? <span className={val >= 0 ? 'text-green-400' : 'text-red-400'}>{formatCurrency(val)}</span>
                    : <span className="text-gray-500">—</span>;
                })()}
              </InfoRow>
            </div>
          </GlassCard>

          {/* Deduction Summary - authoritative total from trade-level analysis */}
          {calculatedTotal > 0 && (
            <GlassCard padding="sm">
              <h4 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                <DollarSign className="h-3 w-3" /> Deduction Summary
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button onClick={() => setInternalModalOpen(true)} className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-center hover:bg-red-500/20 hover:border-red-500/50 transition-all cursor-pointer">
                  <div className="text-lg font-bold text-red-400">{formatCurrency(calculatedTotal)}</div>
                  <div className="text-[10px] text-gray-400 uppercase tracking-wider mt-1">Total Deductions</div>
                  <div className="text-[9px] text-gray-600 mt-0.5">{analysisSummary?.violatingTradeCount || 0} flagged trades — click for details</div>
                </button>
              </div>
            </GlassCard>
          )}

          {/* Violation Breakdown with detailed trades */}
          <GlassCard padding="sm">
            <h4 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              <AlertTriangle className="h-3 w-3" /> Violation Breakdown
            </h4>
            {(data.violationBreakdown.length > 0 || Object.keys(flaggedByTypeKey).length > 0) ? (
              <div className="space-y-3">
                {/* Per-type cards with trade details */}
                {Object.entries(flaggedByTypeKey).map(([typeKey, typeTrades]) => {
                  const typeDeduction = typeTrades.reduce((s: number, t: any) => s + (t.deductionAmount || 0), 0);
                  const symbols = [...new Set(typeTrades.map((t: any) => t.symbol))];
                  const label = TYPE_KEY_TO_LABEL[typeKey] || typeKey;
                  // Top 3 trades by deduction
                  const topTrades = [...typeTrades].sort((a: any, b: any) => b.deductionAmount - a.deductionAmount).slice(0, 3);

                  return (
                    <div key={typeKey} className="rounded-lg border border-white/10 bg-black/30 overflow-hidden">
                      {/* Type header */}
                      <div className="flex items-center justify-between px-4 py-2.5 bg-white/[0.03] border-b border-white/5">
                        <div className="flex items-center gap-2">
                          <Badge variant={BADGE_VARIANT[typeKey] || 'red'}>{label}</Badge>
                          <span className="text-xs text-gray-400">{typeTrades.length} trade{typeTrades.length !== 1 ? 's'  : ''}</span>
                          <span className="text-[10px] text-gray-600">|</span>
                          <span className="text-[10px] text-gray-500">{symbols.join(', ')}</span>
                        </div>
                        <span className="text-red-400 font-bold text-sm">{formatCurrency(typeDeduction)}</span>
                      </div>
                      {/* Violation type explanation */}
                      {VIOLATION_TYPE_DESCRIPTIONS[typeKey] && (
                        <div className="px-4 py-2 border-b border-white/5 bg-white/[0.01]">
                          <p className="text-[10px] text-gray-500 leading-relaxed">{VIOLATION_TYPE_DESCRIPTIONS[typeKey]}</p>
                        </div>
                      )}
                      {/* Top trades preview */}
                      <div className="px-4 py-2 space-y-1">
                        {topTrades.map((t: any, i: number) => (
                          <div key={t.tradeId || i} className="flex items-center gap-3 text-[11px]">
                            <span className="text-gray-500 w-4 shrink-0">{i + 1}.</span>
                            <span className="text-white font-medium w-[70px] shrink-0">{t.symbol}</span>
                            <span className="text-gray-400 w-[60px] shrink-0">{t.side} {t.lots?.toFixed(2)}</span>
                            <span className="text-gray-500 whitespace-nowrap w-[55px] shrink-0">
                              {(t.duration || 0) < 1 ? `${Math.round((t.duration || 0) * 60)}m` : `${(t.duration || 0).toFixed(1)}h`}
                            </span>
                            <span className={`font-semibold w-[65px] shrink-0 ${t.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {formatCurrency(t.profit)}
                            </span>
                            <span className="text-red-400 font-semibold w-[65px] shrink-0">-{formatCurrency(t.deductionAmount ?? 0)}</span>
                            <span className="text-gray-600 text-[10px] truncate flex-1">{t.explanation}</span>
                          </div>
                        ))}
                        {typeTrades.length > 3 && (
                          <div className="text-[10px] text-gray-600 pl-4">
                            ... and {typeTrades.length - 3} more trade{typeTrades.length - 3 !== 1 ? 's' : ''}
                          </div>
                        )}
                      </div>
                      {/* View all link */}
                      <div className="flex items-center justify-between px-4 py-2 border-t border-white/5">
                        <button
                          onClick={() => setModalTypeKey(typeKey)}
                          className="flex items-center gap-1.5 text-[11px] text-red-400 hover:text-red-300 transition-colors"
                        >
                          <Eye className="h-3 w-3" />
                          View violation breakdown →
                        </button>
                        <ReportDownloadButtons
                          violationId={`${accountId}-${typeKey}`}
                          accountId={accountId}
                          size="icon"
                        />
                      </div>
                    </div>
                  );
                })}

                {/* platform-only violations (not detected by our engine) — clickable for trade review */}
                {data.violationBreakdown.filter((v: any) => !flaggedByTypeKey[v.type]).length > 0 && (
                  <div className="mt-2">
                    <div className="text-[10px] text-gray-500 mb-1.5">Additional violations reported by the Trading Platform (click to review trades):</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                      {data.violationBreakdown
                        .filter((v: any) => !flaggedByTypeKey[v.type])
                        .map((v: any) => (
                          <button
                            key={v.type}
                            onClick={() => setModalTypeKey(v.type)}
                            className="flex items-center justify-between rounded-lg border border-white/10 bg-black/30 px-3 py-2 hover:bg-white/[0.06] hover:border-yellow-500/30 transition-all group cursor-pointer text-left"
                          >
                            <div className="flex items-center gap-1.5">
                              <Badge variant={BADGE_VARIANT[v.type] || 'red'}>{v.label}</Badge>
                              <span className={`text-[9px] px-1 py-px rounded-full border ${v.severity === 'critical' || v.severity === 'high' ? 'bg-red-500/20 text-red-400 border-red-500/30' : v.severity === 'medium' ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' : 'bg-blue-500/20 text-blue-400 border-blue-500/30'}`}>{v.severity}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-red-400 font-bold text-xs">{formatCurrency(v.amount)}</span>
                              <Eye className="h-3 w-3 text-gray-600 group-hover:text-yellow-400 transition-colors" />
                            </div>
                          </button>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-500">No violations detected for this account.</p>
            )}
          </GlassCard>

          {/* Trade Analysis Summary - clickable badges */}
          {analysisSummary && analysisSummary.violatingTradeCount > 0 && (
            <GlassCard padding="sm">
              <h4 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                <FileWarning className="h-3 w-3" /> Internal Analysis Summary
              </h4>
              <div className="flex items-center gap-4 mb-3 text-xs">
                <span className="text-gray-500">Flagged Trades:</span>
                <span className="text-red-400 font-bold">{analysisSummary.violatingTradeCount}</span>
                <span className="text-gray-500">Total Deduction:</span>
                <span className="text-red-400 font-bold">{formatCurrency(analysisSummary.totalDeductions)}</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {Object.entries(analysisSummary.violationTypeCount as Record<string, number>).map(([type, count]) => {
                  const typeDeduction = analysisSummary.deductionsByType?.[type] || 0;
                  return (
                    <button
                      key={type}
                      onClick={() => setModalTypeKey(type)}
                      className="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 hover:bg-white/[0.06] hover:border-red-500/30 transition-all group cursor-pointer text-left"
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant={BADGE_VARIANT[type] || 'red'}>{TYPE_KEY_TO_LABEL[type] || type}</Badge>
                        <span className="text-xs text-gray-400">{count} trade{count !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-red-400 font-semibold">{formatCurrency(typeDeduction)}</span>
                        <Eye className="h-3 w-3 text-gray-600 group-hover:text-red-400 transition-colors" />
                      </div>
                    </button>
                  );
                })}
              </div>
              <button
                onClick={() => setActiveTab('flagged')}
                className="mt-3 text-[11px] text-red-400 hover:text-red-300 transition-colors"
              >
                View all flagged trades →
              </button>
            </GlassCard>
          )}

          {/* Deduction Events */}
          <GlassCard padding="sm">
            <h4 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              <DollarSign className="h-3 w-3" /> Deduction History (Ledger Events)
            </h4>
            {data.deductionEvents.length > 0 ? (
              <div className="space-y-1.5">
                {data.deductionEvents.map((evt: any, idx: number) => (
                  <div key={idx} className="flex items-center gap-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs">
                    <span className="text-gray-500 shrink-0 whitespace-nowrap">{formatDateTime(evt.time)}</span>
                    <span className={`font-semibold shrink-0 whitespace-nowrap ${evt.amount < 0 ? 'text-red-400' : 'text-green-400'}`}>{formatCurrency(evt.amount)}</span>
                    <span className="text-gray-300 flex-1">{evt.note}</span>
                    {evt.balanceAfter != null && <span className="text-gray-500 shrink-0 whitespace-nowrap">Bal: {formatCurrency(evt.balanceAfter)}</span>}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500">No deduction events found in account ledger.</p>
            )}
          </GlassCard>
        </div>
      )}

      {/* === FLAGGED TRADES TAB === */}
      {activeTab === 'flagged' && (
        <div className="space-y-4">
          {flaggedTrades.length > 0 ? (
            <>
              <div className="flex items-center justify-between">
                <div className="text-xs text-gray-500">
                  {flaggedTrades.length} trades flagged across {Object.keys(flaggedByType).length} violation type{Object.keys(flaggedByType).length !== 1 ? 's' : ''}.
                  Total deduction: <span className="text-red-400 font-semibold">{formatCurrency(analysisSummary?.totalDeductions || 0)}</span>
                </div>
                <Button variant="secondary" size="sm" onClick={exportFlaggedTrades}>
                  <Download className="h-3.5 w-3.5 mr-1.5" /> Export Flagged CSV
                </Button>
              </div>

              {/* Group by violation type */}
              {Object.entries(flaggedByType).map(([typeLabel, typeTrades]) => (
                <GlassCard key={typeLabel} padding="sm">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                      <AlertTriangle className="h-3 w-3" /> {typeLabel}
                    </h4>
                    <span className="text-xs text-gray-500">{typeTrades.length} trade{typeTrades.length !== 1 ? 's' : ''}</span>
                  </div>
                  <DataTable columns={flaggedColumns} data={typeTrades} emptyMessage="No flagged trades" />
                </GlassCard>
              ))}
            </>
          ) : (
            <div className="text-center py-12 text-gray-500">
              <FileWarning className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p>No trades flagged by the violation analysis engine.</p>
              <p className="text-xs mt-1">This does not necessarily mean there are no violations — Trading Platform deductions may use different detection criteria.</p>
            </div>
          )}
        </div>
      )}

      {/* === ALL TRADES TAB === */}
      {activeTab === 'trades' && (
        <div className="space-y-4">
          {trades.length > 0 ? (
            <>
              <div className="flex items-center justify-between">
                <div className="text-xs text-gray-500">
                  Showing {Math.min(tradePerPage, trades.length - (tradePage - 1) * tradePerPage)} of {data.tradeTotal || trades.length} closed trades.
                </div>
                <Button variant="secondary" size="sm" onClick={exportAllTrades}>
                  <Download className="h-3.5 w-3.5 mr-1.5" /> Export All CSV
                </Button>
              </div>
              <GlassCard padding="none">
                <DataTable columns={tradeColumns} data={trades.slice((tradePage - 1) * tradePerPage, tradePage * tradePerPage)} emptyMessage="No trades found" />
                {trades.length > tradePerPage && (
                  <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/10">
                    <span className="text-[10px] text-gray-500">Page {tradePage} of {Math.ceil(trades.length / tradePerPage)}</span>
                    <div className="flex gap-2">
                      <button onClick={() => setTradePage(Math.max(1, tradePage - 1))} disabled={tradePage === 1} className="px-2.5 py-1 text-[10px] rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30">Previous</button>
                      <button onClick={() => setTradePage(Math.min(Math.ceil(trades.length / tradePerPage), tradePage + 1))} disabled={tradePage >= Math.ceil(trades.length / tradePerPage)} className="px-2.5 py-1 text-[10px] rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30">Next</button>
                    </div>
                  </div>
                )}
              </GlassCard>
            </>
          ) : (
            <div className="text-center py-12 text-gray-500">
              <Activity className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p>No trade data available for this account.</p>
              <p className="text-xs mt-1">Trade history requires a valid user email for the account.</p>
            </div>
          )}
        </div>
      )}

      {/* === STATS TAB === */}
      {activeTab === 'stats' && stats ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <StatBox label="Total P&L" value={formatCurrency(stats.totals?.totalPnL || 0)} color={stats.totals?.totalPnL >= 0 ? 'text-green-400' : 'text-red-400'} />
            <StatBox label="Total Trades" value={stats.totals?.totalTrades || 0} />
            <StatBox label="Win Rate" value={`${((stats.winRates?.all || 0) * 100).toFixed(1)}%`} color={stats.winRates?.all >= 0.5 ? 'text-green-400' : 'text-red-400'} />
            <StatBox label="Profit Factor" value={(stats.ratios?.profitFactor || 0).toFixed(2)} color={stats.ratios?.profitFactor >= 1 ? 'text-green-400' : 'text-red-400'} />
            <StatBox label="Avg Win" value={formatCurrency(stats.totals?.averageWin || 0)} color="text-green-400" />
            <StatBox label="Avg Loss" value={formatCurrency(stats.totals?.averageLoss || 0)} color="text-red-400" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <GlassCard padding="sm">
              <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                <TrendingUp className="h-3 w-3" /> Win/Loss Breakdown
              </h4>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                <InfoRow label="Winning Trades:">{stats.totals?.winningTrades || 0}</InfoRow>
                <InfoRow label="Losing Trades:">{stats.totals?.losingTrades || 0}</InfoRow>
                <InfoRow label="Largest Win:"><span className="text-green-400">{formatCurrency(stats.totals?.largestProfitTrade || 0)}</span></InfoRow>
                <InfoRow label="Largest Loss:"><span className="text-red-400">{formatCurrency(stats.totals?.largestLossTrade || 0)}</span></InfoRow>
                <InfoRow label="Long Win Rate:">{((stats.winRates?.long || 0) * 100).toFixed(1)}%</InfoRow>
                <InfoRow label="Short Win Rate:">{((stats.winRates?.short || 0) * 100).toFixed(1)}%</InfoRow>
                <InfoRow label="Max Consec. Wins:">{stats.streaks?.maxConsecutiveWins}</InfoRow>
                <InfoRow label="Max Consec. Losses:">{stats.streaks?.maxConsecutiveLosses}</InfoRow>
                <InfoRow label="Total Volume:">{formatCurrency(stats.totals?.totalVolumeUSD || 0)}</InfoRow>
                <InfoRow label="Total Lots:">{(stats.totals?.totalLots || 0).toFixed(2)}</InfoRow>
                <InfoRow label="Commissions:"><span className="text-red-400">{formatCurrency(stats.totals?.totalCommissions || 0)}</span></InfoRow>
                <InfoRow label="Swaps:"><span className="text-red-400">{formatCurrency(stats.totals?.totalSwaps || 0)}</span></InfoRow>
              </div>
            </GlassCard>

            <GlassCard padding="sm">
              <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                <Clock className="h-3 w-3" /> Time & Duration
              </h4>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                <InfoRow label="Avg Hold (All):">{stats.time?.avgHoldAll_human || '—'}</InfoRow>
                <InfoRow label="Avg Hold (Win):">{stats.time?.avgHoldWin_human || '—'}</InfoRow>
                <InfoRow label="Avg Hold (Loss):">{stats.time?.avgHoldLoss_human || '—'}</InfoRow>
                <InfoRow label="Trading Days:">{stats.daily?.totalTradingDays || 0}</InfoRow>
                <InfoRow label="Winning Days:">{stats.daily?.winningDays || 0}</InfoRow>
                <InfoRow label="Losing Days:">{stats.daily?.losingDays || 0}</InfoRow>
                <InfoRow label="Avg Daily P&L:">{formatCurrency(stats.daily?.avgDailyPnl || 0)}</InfoRow>
                <InfoRow label="Max Drawdown:"><span className="text-red-400">{formatCurrency(stats.drawdowns?.maxDrawdown || 0)}</span></InfoRow>
              </div>
              {stats.daily?.largestProfitableDay && (
                <div className="mt-2 text-[11px] text-gray-500">
                  Best day: <span className="text-green-400">{formatCurrency(stats.daily.largestProfitableDay.pnl)}</span> on {stats.daily.largestProfitableDay.day}
                </div>
              )}
              {stats.daily?.largestLosingDay && (
                <div className="text-[11px] text-gray-500">
                  Worst day: <span className="text-red-400">{formatCurrency(stats.daily.largestLosingDay.pnl)}</span> on {stats.daily.largestLosingDay.day}
                </div>
              )}
            </GlassCard>
          </div>

          {stats.bySymbol?.performance && stats.bySymbol.performance.length > 0 && (
            <GlassCard padding="sm">
              <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                <Activity className="h-3 w-3" /> Performance by Symbol
              </h4>
              <div className="space-y-1.5">
                {stats.bySymbol.performance.map((s: any) => {
                  const pnl = stats.bySymbol.pnl.find((p: any) => p.symbol === s.symbol)?.pnl || 0;
                  const lots = stats.bySymbol.lots.find((l: any) => l.symbol === s.symbol)?.lots || 0;
                  return (
                    <div key={s.symbol} className="flex items-center gap-4 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs">
                      <span className="font-semibold text-white w-[70px]">{s.symbol}</span>
                      <span className="text-gray-400">{s.trades} trades</span>
                      <span className="text-gray-400">{(s.winRate * 100).toFixed(0)}% WR</span>
                      <span className="text-gray-400">{lots.toFixed(2)} lots</span>
                      <span className={`font-semibold ml-auto ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{formatCurrency(pnl)}</span>
                    </div>
                  );
                })}
              </div>
            </GlassCard>
          )}

          <GlassCard padding="sm">
            <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              <Shield className="h-3 w-3" /> Risk Ratios
            </h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatBox label="Sharpe Ratio" value={(stats.ratios?.sharpeRatio || 0).toFixed(2)} />
              <StatBox label="Sortino Ratio" value={(stats.ratios?.sortinoRatio || 0).toFixed(2)} />
              <StatBox label="Profit Factor" value={(stats.ratios?.profitFactor || 0).toFixed(2)} color={stats.ratios?.profitFactor >= 1 ? 'text-green-400' : 'text-red-400'} />
              <StatBox label="Expectancy" value={formatCurrency(stats.ratios?.tradeExpectancy || 0)} color={stats.ratios?.tradeExpectancy >= 0 ? 'text-green-400' : 'text-red-400'} />
            </div>
          </GlassCard>
        </div>
      ) : activeTab === 'stats' && !stats ? (
        <div className="text-center py-12 text-gray-500">
          <BarChart3 className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p>No trade statistics available for this account.</p>
        </div>
      ) : null}
    </div>
  );
}
