'use client';

import { useState, useCallback, useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { GlassCard } from '@/components/ui/glass-card';
import { Modal } from '@/components/ui/modal';
import { formatCurrency, formatDate } from '@/lib/utils/format';
import {
  Shield, Globe, AlertTriangle, Search, Loader2, User, DollarSign,
  BarChart3, CheckCircle2, XCircle, Clock, Copy, Check, Mail, FileText,
} from 'lucide-react';
import { SendPayoutEmailModal } from './send-payout-email-modal';
import { composeDecisionRationale } from '@/lib/payouts/decision';
import type { PayoutRecord, PayoutStatus, IPCheckResult } from '@/types/payouts';

const VIOLATION_LABELS: Record<string, string> = {
  overleveraging: 'Overleveraging', hft: 'HFT', martingale: 'Martingale',
  news: 'News Trading', grid: 'Grid Trading', copy: 'Copy Trading',
  overnight: 'Overnight',
};

export interface PayoutAnalysisResult {
  violation_details: Record<string, { trade_id: string; explanation: string; amount: number }[]>;
  deduction_breakdown: Record<string, number>;
  trades: Array<{
    _id: string; position?: string; trdSymbol: string; side: string; lots: number;
    openTime: string; closeTime: string; openPrice: number; closePrice: number;
    profit: number; commission: number; swap: number; duration: number;
  }>;
  news_events: Array<{ title: string; country: string; date: string; impact: string; source: string }>;
  total_deductions: number;
  violation_count: number;
  flagged_trade_count: number;
  trades_fetched: boolean;
}

interface ExpandedPayoutProps {
  record: PayoutRecord;
  analysis: PayoutAnalysisResult | null;
  analyzing: boolean;
  onStatusChange: (id: string, status: PayoutStatus) => void;
  onNotesChange: (id: string, notes: string) => void;
  onPreApproval?: (id: string, status: number, note?: string) => void;
  onFinalAction?: (id: string, action: 'approve' | 'reject', note?: string) => void;
}

function CopyableField({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);

  return (
    <button onClick={(e) => { e.stopPropagation(); handleCopy(); }} className={`inline-flex items-center gap-1 hover:text-red-400 transition-colors ${className || ''}`} title="Click to copy">
      {value}
      {copied ? <Check className="h-2.5 w-2.5 text-green-400" /> : <Copy className="h-2.5 w-2.5 text-gray-500" />}
    </button>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[11px] text-gray-500 shrink-0">{label}</span>
      <span className="text-xs text-gray-200 truncate">{children}</span>
    </div>
  );
}

export function ExpandedPayout({ record, analysis, analyzing, onStatusChange, onNotesChange, onPreApproval, onFinalAction }: ExpandedPayoutProps) {
  const [notes, setNotes] = useState(record.notes || '');
  const [ipInput, setIpInput] = useState('');
  const [ipResults, setIpResults] = useState<IPCheckResult[]>([]);
  const [ipLoading, setIpLoading] = useState(false);
  const [riskLoading, setRiskLoading] = useState(false);
  const [riskResult, setRiskResult] = useState<any>(null);
  const [preApprovalLoading, setPreApprovalLoading] = useState(false);
  const [finalActionLoading, setFinalActionLoading] = useState<string | null>(null);
  const [sendEmailOpen, setSendEmailOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'approve' | 'reject' | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);

  const requestAmount = record.profitSharePercentage && record.profitSharePercentage > 0 && record.profitSharePercentage < 100 && (record.clientAmount ?? 0) > 0
    ? (record.clientAmount!) / (record.profitSharePercentage / 100)
    : record.amount ?? record.clientAmount ?? 0;

  const handleIpCheck = async () => {
    const ips = ipInput.split(',').map(s => s.trim()).filter(s => s.length >= 7);
    if (ips.length === 0) return;
    setIpLoading(true);
    try {
      const res = await fetch('/api/payouts/ip-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ips, kycCountry: record.kycCountry }),
      });
      const json = await res.json();
      if (json.data?.results) setIpResults(json.data.results);
    } catch { /* noop */ } finally { setIpLoading(false); }
  };

  const handleRiskCheck = async () => {
    const accountId = record.accountId || record.login;
    if (!accountId) return;
    setRiskLoading(true);
    try {
      const res = await fetch(`/api/payouts/${accountId}/risk-check`, { method: 'POST' });
      const json = await res.json();
      setRiskResult(json.data);
    } catch { /* noop */ } finally { setRiskLoading(false); }
  };

  const handlePreApproval = async (status: number) => {
    if (!onPreApproval) return;
    setPreApprovalLoading(true);
    try { await onPreApproval(record.id, status, notes || undefined); }
    finally { setPreApprovalLoading(false); }
  };

  const handleFinalAction = async (action: 'approve' | 'reject') => {
    if (!onFinalAction) return;
    setFinalActionLoading(action);
    try { await onFinalAction(record.id, action, notes || undefined); }
    finally { setFinalActionLoading(null); }
  };

  // Explainable decision preview for the confirm modal — composed client-side
  // from the same record + analysis already loaded, so the trader sees the
  // rationale before the finalize call goes out (the API composes and
  // persists its own copy in `/api/payouts/[id]/preapprove`).
  const composedDecision = useMemo(() => {
    if (!confirmAction) return null;
    return composeDecisionRationale({
      record,
      analysis: analysis
        ? {
            violation_details: analysis.violation_details,
            deduction_breakdown: analysis.deduction_breakdown,
            total_deductions: analysis.total_deductions,
            violation_count: analysis.violation_count,
          }
        : null,
      decision: confirmAction,
    });
  }, [confirmAction, record, analysis]);

  const handleConfirmFinalAction = async () => {
    if (!confirmAction) return;
    const action = confirmAction;
    setConfirmAction(null);
    await handleFinalAction(action);
  };

  const handleGenerateEvidence = async () => {
    setEvidenceLoading(true);
    try {
      const subjectId = record._id || record.accountId || record.id;
      const res = await fetch('/api/evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectType: 'payout', subjectId, accountId: record.accountId }),
      });
      const json = await res.json().catch(() => null);
      const packId = json?.id || json?.data?.id;
      if (packId) window.open(`/evidence/${packId}`, '_blank');
    } catch { /* noop */ }
    finally { setEvidenceLoading(false); }
  };

  const preApprovalLabel = record.preApprovedStatus === 1 ? 'Pre-Approved' : record.preApprovedStatus === -1 ? 'Not Pre-Approved' : 'Not Reviewed';
  const preApprovalVariant = record.preApprovedStatus === 1 ? 'green' as const : record.preApprovedStatus === -1 ? 'red' as const : 'silver' as const;

  // Build violation map for trade highlighting
  const buildViolationMap = () => {
    const map = new Map<string, string[]>();
    if (!analysis?.violation_details) return map;
    for (const [typeKey, details] of Object.entries(analysis.violation_details)) {
      for (const d of details) {
        const existing = map.get(d.trade_id) || [];
        if (!existing.includes(typeKey)) existing.push(typeKey);
        map.set(d.trade_id, existing);
      }
    }
    return map;
  };

  const statusButtons: { status: PayoutStatus; label: string; variant: 'primary' | 'success' | 'warning' | 'secondary' | 'danger' }[] = [
    { status: 'Investigate', label: 'Investigate', variant: 'warning' },
    { status: 'Cleared', label: 'Clear', variant: 'success' },
    { status: 'Rejected', label: 'Reject', variant: 'danger' },
    { status: 'Banned', label: 'Ban', variant: 'danger' },
  ];

  return (
    <div className="px-4 py-3 space-y-3 bg-white/[0.02] border-t border-white/5">
      {/* Row 1: Account Info + KYC + Payout Details */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <GlassCard padding="sm">
          <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            <Shield className="h-3 w-3" /> Account
          </h4>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            <InfoRow label="Login:">{record.login ? <CopyableField value={record.login} className="font-mono text-white" /> : '—'}</InfoRow>
            <InfoRow label="Account:">{record.accountId ? <CopyableField value={record.accountId} className="font-mono" /> : '—'}</InfoRow>
            <InfoRow label="Email:">{record.email ? <CopyableField value={record.email} /> : '—'}</InfoRow>
            <InfoRow label="Name:">{record.firstName && record.lastName ? `${record.firstName} ${record.lastName}` : '—'}</InfoRow>
            <InfoRow label="Country:">{record.kycCountry || record.country || '—'}</InfoRow>
            <InfoRow label="Plan:"><span className="truncate max-w-[140px] block">{record.plan || '—'}</span></InfoRow>
            <InfoRow label="Date:">{record.dateRequested ? formatDate(record.dateRequested) : '—'}</InfoRow>
            <InfoRow label="Order:"><span className="font-mono">{record.orderNumber}</span></InfoRow>
          </div>
        </GlassCard>

        <GlassCard padding="sm">
          <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            <User className="h-3 w-3" /> KYC & User
          </h4>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            <InfoRow label="KYC:">
              <Badge variant={record.kycStatus === 'Verified' || record.kycStatus === 'COMPLETED' ? 'green' : 'yellow'}>
                {record.kycStatus === 'COMPLETED' ? 'Verified' : record.kycStatus}
              </Badge>
            </InfoRow>
            <InfoRow label="Verified:">
              <span className={record.kycVerified ? 'text-green-400' : 'text-yellow-400'}>{record.kycVerified ? 'Yes' : 'No'}</span>
            </InfoRow>
            <InfoRow label="Blacklisted:">
              <span className={record.isBlackListed ? 'text-red-400 font-semibold' : 'text-green-400'}>{record.isBlackListed ? 'YES' : 'No'}</span>
            </InfoRow>
            <InfoRow label="Customer:"><span className="font-mono">{record.customerId || '—'}</span></InfoRow>
          </div>
          {record.kycRiskLabels && record.kycRiskLabels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {record.kycRiskLabels.map((l) => <Badge key={l} variant="yellow" className="!text-[10px]">{l}</Badge>)}
            </div>
          )}
        </GlassCard>

        <GlassCard padding="sm">
          <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            <DollarSign className="h-3 w-3" /> Payout Details
          </h4>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            <InfoRow label="Request:"><span className="font-semibold text-white">{formatCurrency(requestAmount)}</span></InfoRow>
            <InfoRow label="Client:"><span className="font-semibold text-green-400">{formatCurrency(record.clientAmount ?? 0)}</span></InfoRow>
            <InfoRow label="Fee:">{formatCurrency(record.fee || 0)}</InfoRow>
            <InfoRow label="Profit Share:">{record.profitSharePercentage ? `${record.profitSharePercentage}%` : '—'}</InfoRow>
            <InfoRow label="Method:"><span className="uppercase">{record.method || '—'}</span></InfoRow>
            <InfoRow label="Balance:">{record.balance ? formatCurrency(record.balance) : '—'}</InfoRow>
            <InfoRow label="Total P&L:">
              <span className={(record.totalPnL || 0) >= 0 ? 'text-green-400' : 'text-red-400'}>
                {record.totalPnL != null ? formatCurrency(record.totalPnL) : '—'}
              </span>
            </InfoRow>
            <InfoRow label="Pre-Approval:"><Badge variant={preApprovalVariant}>{preApprovalLabel}</Badge></InfoRow>
          </div>
        </GlassCard>
      </div>

      {/* Row 2: Account Metrics */}
      {(record.startingBalance != null || record.tradedDays != null) && (
        <GlassCard padding="sm">
          <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            <BarChart3 className="h-3 w-3" /> Account Metrics
          </h4>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-x-4 gap-y-1.5">
            {(record.startingBalance || record.accountSize) != null && (
              <InfoRow label="Starting Bal:">{formatCurrency(record.startingBalance || record.accountSize || 0)}</InfoRow>
            )}
            {record.tradedDays != null && <InfoRow label="Traded Days:">{record.tradedDays}</InfoRow>}
            {record.maxDailyProfit != null && <InfoRow label="Max Daily P:">{formatCurrency(record.maxDailyProfit)}</InfoRow>}
            {record.balanceAtRequest != null && <InfoRow label="Bal at Req:">{formatCurrency(record.balanceAtRequest)}</InfoRow>}
            {record.numApprovedPayouts != null && (
              <InfoRow label="Approved:">{record.numApprovedPayouts} ({formatCurrency(record.approvedPayouts || 0)})</InfoRow>
            )}
            {record.consistencyAtRequest != null && record.consistencyRequired != null && (
              <InfoRow label="Consistency:">{record.consistencyAtRequest.toFixed(1)}% / {record.consistencyRequired}%</InfoRow>
            )}
          </div>
          <div className="mt-2 flex gap-1.5">
            {record.banNewsTrading && <Badge variant="yellow" className="!text-[10px]">News Trading Restricted</Badge>}
            {record.banHFT && <Badge variant="yellow" className="!text-[10px]">HFT Restricted</Badge>}
            {record.banMTGL && <Badge variant="yellow" className="!text-[10px]">Martingale Restricted</Badge>}
          </div>
        </GlassCard>
      )}

      {/* Analysis loading state */}
      {analyzing && (
        <div className="flex items-center justify-center gap-2 py-6 text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-xs">Analyzing trades...</span>
        </div>
      )}

      {/* Row 3: Violation Breakdown */}
      {analysis && Object.keys(analysis.deduction_breakdown).length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold text-gray-300">
              Violations — {formatCurrency(analysis.total_deductions)} ({analysis.violation_count} flagged trade{analysis.violation_count !== 1 ? 's' : ''})
            </div>
            <button
              onClick={() => setSendEmailOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/30 transition-colors"
            >
              <Mail className="h-3 w-3" /> Send Email
            </button>
          </div>
          {Object.entries(analysis.deduction_breakdown).map(([type, amount]) => {
            const tradeDetails = analysis.violation_details[type] || [];
            return (
              <div key={type} className="rounded-lg border border-white/10 bg-black/20 p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-gray-200">{VIOLATION_LABELS[type] || type}</span>
                  <span className="text-xs font-semibold text-red-400">{formatCurrency(amount)}</span>
                </div>
                {tradeDetails.length > 0 && (
                  <div className="mt-2 space-y-1 max-h-[120px] overflow-y-auto">
                    {tradeDetails.map((td, i) => (
                      <div key={i} className="flex items-start gap-2 text-[10px]">
                        <span className="text-gray-600 shrink-0 font-mono">{td.trade_id}</span>
                        <span className="text-gray-400 flex-1">{td.explanation}</span>
                        <span className="text-red-400 shrink-0">{formatCurrency(td.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* No violations message */}
      {analysis && Object.keys(analysis.deduction_breakdown).length === 0 && (
        <p className="text-xs text-gray-500">No violations detected{!analysis.trades_fetched ? ' (trades could not be fetched)' : ''}</p>
      )}

      {/* Row 4: News Events */}
      {analysis && analysis.news_events.length > 0 && (() => {
        const violationNews = new Set<string>();
        if (analysis.violation_details.news) {
          for (const v of analysis.violation_details.news) {
            const match = v.explanation.match(/"([^"]+)"/);
            if (match) violationNews.add(match[1]);
          }
        }

        return (
          <div className="space-y-1">
            <div className="text-[11px] font-semibold text-gray-300">News Events During Trading — {analysis.news_events.length} high-impact</div>
            <div className="rounded-lg border border-white/10 bg-black/20 overflow-hidden">
              <div className="max-h-[200px] overflow-y-auto">
                <table className="w-full text-[10px]">
                  <thead className="sticky top-0 bg-black/60">
                    <tr className="border-b border-white/10">
                      <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Time (UTC)</th>
                      <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Currency</th>
                      <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Event</th>
                      <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.news_events
                      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
                      .map((evt, i) => {
                        const triggered = violationNews.has(evt.title);
                        return (
                          <tr key={i} className={triggered ? 'bg-red-500/10 border-b border-red-500/10' : 'border-b border-white/5'}>
                            <td className="px-2 py-1 text-gray-400 font-mono">{new Date(evt.date).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                            <td className="px-2 py-1 text-gray-300 font-medium">{evt.country}</td>
                            <td className="px-2 py-1 text-gray-400">{evt.title}</td>
                            <td className="px-2 py-1">
                              {triggered
                                ? <span className="px-1 py-0.5 rounded bg-red-500/20 text-red-400 text-[8px] font-medium uppercase">Flagged</span>
                                : <span className="px-1 py-0.5 rounded bg-gray-500/20 text-gray-500 text-[8px] font-medium uppercase">No violation</span>}
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
      })()}

      {/* Row 5: All Trades Table */}
      {analysis && analysis.trades.length > 0 && (() => {
        const violationMap = buildViolationMap();
        return (
          <div className="space-y-1">
            <div className="text-[11px] font-semibold text-gray-300">Trades — {analysis.trades.length} total</div>
            <div className="rounded-lg border border-white/10 bg-black/20 overflow-hidden">
              <div className="max-h-[300px] overflow-y-auto">
                <table className="w-full text-[10px]">
                  <thead className="sticky top-0 bg-black/60">
                    <tr className="border-b border-white/10">
                      <th className="px-2 py-1.5 text-left text-gray-500 font-medium">ID</th>
                      <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Symbol</th>
                      <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Side</th>
                      <th className="px-2 py-1.5 text-right text-gray-500 font-medium">Lots</th>
                      <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Open</th>
                      <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Close</th>
                      <th className="px-2 py-1.5 text-right text-gray-500 font-medium">Duration</th>
                      <th className="px-2 py-1.5 text-right text-gray-500 font-medium">Profit</th>
                      <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Violations</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.trades.map((t, i) => {
                      const violations = violationMap.get(t.position || t._id) || violationMap.get(t._id);
                      const isFlagged = !!violations;
                      const durationMin = t.duration * 60;
                      const durationStr = durationMin < 60
                        ? `${durationMin.toFixed(0)}s`
                        : durationMin < 3600
                          ? `${(durationMin / 60).toFixed(0)}m`
                          : `${(durationMin / 3600).toFixed(1)}h`;

                      return (
                        <tr
                          key={t._id || i}
                          className={isFlagged
                            ? 'bg-red-500/10 border-b border-red-500/10'
                            : 'border-b border-white/5 hover:bg-white/[0.02]'}
                        >
                          <td className="px-2 py-1 font-mono text-gray-500">{t.position || t._id}</td>
                          <td className="px-2 py-1 font-mono text-gray-300">{t.trdSymbol}</td>
                          <td className="px-2 py-1">
                            <span className={t.side === 'Buy' ? 'text-green-400' : 'text-red-400'}>{t.side}</span>
                          </td>
                          <td className="px-2 py-1 text-right text-gray-400">{t.lots}</td>
                          <td className="px-2 py-1 text-gray-500">{new Date(t.openTime).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                          <td className="px-2 py-1 text-gray-500">{new Date(t.closeTime).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                          <td className="px-2 py-1 text-right text-gray-400">{durationStr}</td>
                          <td className={`px-2 py-1 text-right font-medium ${t.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {formatCurrency(t.profit)}
                          </td>
                          <td className="px-2 py-1">
                            {violations ? (
                              <div className="flex gap-0.5 flex-wrap">
                                {violations.map((v) => (
                                  <span key={v} className="px-1 py-0.5 rounded bg-red-500/20 text-red-400 text-[8px] font-medium uppercase">{v}</span>
                                ))}
                              </div>
                            ) : null}
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
      })()}

      {/* Row 6: Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Risk Check + IP Check */}
        <GlassCard padding="sm">
          <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            <AlertTriangle className="h-3 w-3" /> Risk & IP Check
          </h4>
          <div className="flex gap-2 mb-2">
            <Button variant="secondary" size="sm" onClick={handleRiskCheck} disabled={riskLoading}>
              {riskLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Search className="mr-1.5 h-3.5 w-3.5" />}
              Risk Check
            </Button>
          </div>
          {riskResult && <p className="mb-2 text-[11px] text-gray-400">{riskResult.details}</p>}
          <div className="flex gap-2">
            <input
              type="text"
              value={ipInput}
              onChange={(e) => setIpInput(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="IP address(es), comma separated"
              className="flex-1 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:border-red-500/50 focus:outline-none"
            />
            <Button variant="secondary" size="sm" onClick={handleIpCheck} disabled={ipLoading || !ipInput.trim()}>
              {ipLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Globe className="mr-1.5 h-3.5 w-3.5" />}
              Check IP
            </Button>
          </div>
          {ipResults.length > 0 && (
            <div className="mt-2 space-y-1">
              {ipResults.map((r) => (
                <div key={r.ip} className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px]">
                  <span className="font-mono text-gray-300">{r.ip}</span>
                  <span className="text-gray-400">{r.city}, {r.country}</span>
                  <span className="text-gray-500">{r.isp}</span>
                  {r.isVpn && <Badge variant="red" className="!text-[10px]">VPN</Badge>}
                  {r.isProxy && <Badge variant="red" className="!text-[10px]">Proxy</Badge>}
                  {r.isTor && <Badge variant="red" className="!text-[10px]">TOR</Badge>}
                  {r.isDatacenter && <Badge variant="yellow" className="!text-[10px]">DC</Badge>}
                </div>
              ))}
            </div>
          )}
        </GlassCard>

        {/* Notes + Status */}
        <GlassCard padding="sm">
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">Notes & Status</h4>
          <textarea
            className="w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:border-red-500/50 focus:outline-none resize-none"
            rows={2}
            value={notes}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Add review notes..."
          />
          <div className="mt-1.5 flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => onNotesChange(record.id, notes)}>Save Notes</Button>
            <div className="flex gap-1">
              {statusButtons.map(({ status, label, variant }) => (
                <Button key={status} variant={variant} size="sm" onClick={() => onStatusChange(record.id, status)} disabled={record.status === status}>
                  {label}
                </Button>
              ))}
            </div>
            <span className="text-[10px] text-gray-500 ml-auto">
              <Badge variant={record.status === 'Cleared' ? 'green' : record.status === 'Pending' ? 'yellow' : 'red'}>{record.status}</Badge>
            </span>
          </div>
        </GlassCard>
      </div>

      {/* Pre-Approval + Final Actions */}
      <GlassCard padding="sm">
        <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          <CheckCircle2 className="h-3 w-3" /> Pre-Approval (Synced with Trading Platform)
        </h4>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[11px] text-gray-500">Current:</span>
          <Badge variant={preApprovalVariant}>{preApprovalLabel}</Badge>
          {record.preApprovedBy && <span className="text-[10px] text-gray-500">by {record.preApprovedBy}</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="success" size="sm" onClick={() => handlePreApproval(1)} disabled={preApprovalLoading || record.preApprovedStatus === 1}>
            {preApprovalLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}
            Pre-Approve
          </Button>
          <Button variant="secondary" size="sm" onClick={() => handlePreApproval(0)} disabled={preApprovalLoading || record.preApprovedStatus === 0 || record.preApprovedStatus == null}>
            {preApprovalLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Clock className="mr-1 h-3 w-3" />}
            Not Reviewed
          </Button>
          <Button variant="warning" size="sm" onClick={() => handlePreApproval(-1)} disabled={preApprovalLoading || record.preApprovedStatus === -1}>
            {preApprovalLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <XCircle className="mr-1 h-3 w-3" />}
            Not Pre-Approved
          </Button>
          <div className="ml-4 pl-4 border-l border-white/10 flex gap-2">
            <Button variant="success" size="sm" onClick={() => setConfirmAction('approve')} disabled={!!finalActionLoading}>
              {finalActionLoading === 'approve' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}
              Approve (Paid)
            </Button>
            <Button variant="danger" size="sm" onClick={() => setConfirmAction('reject')} disabled={!!finalActionLoading}>
              {finalActionLoading === 'reject' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <XCircle className="mr-1 h-3 w-3" />}
              Reject (Not Paid)
            </Button>
          </div>
        </div>
      </GlassCard>

      {/* Send Email Modal */}
      {analysis && analysis.total_deductions > 0 && (
        <SendPayoutEmailModal
          record={record}
          analysis={analysis}
          isOpen={sendEmailOpen}
          onClose={() => setSendEmailOpen(false)}
        />
      )}

      {/* Decision Confirm Modal — explainable payout decision preview */}
      <Modal
        isOpen={!!confirmAction && !!composedDecision}
        onClose={() => setConfirmAction(null)}
        title={confirmAction === 'approve' ? 'Confirm Approval' : 'Confirm Rejection'}
        size="lg"
      >
        {composedDecision && (
          <div className="space-y-4">
            <p className="text-sm text-gray-300 leading-relaxed">{composedDecision.explanation}</p>

            {composedDecision.rationale.citedRules.length > 0 && (
              <div>
                <h5 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">Cited Rules</h5>
                <div className="rounded-lg border border-white/10 bg-black/20 overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-white/10 text-gray-500">
                        <th className="text-left px-2.5 py-1.5 font-medium">Rule</th>
                        <th className="text-left px-2.5 py-1.5 font-medium">Observed</th>
                        <th className="text-right px-2.5 py-1.5 font-medium">Deduction</th>
                      </tr>
                    </thead>
                    <tbody>
                      {composedDecision.rationale.citedRules.map((r) => (
                        <tr key={r.ruleId} className="border-b border-white/5 last:border-0">
                          <td className="px-2.5 py-1.5 text-gray-200">{r.label}</td>
                          <td className="px-2.5 py-1.5 text-gray-400">{r.observed}</td>
                          <td className="px-2.5 py-1.5 text-right text-red-400">{formatCurrency(r.deduction)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-gray-500">Requested</span>
                <span className="text-gray-200">{formatCurrency(composedDecision.rationale.math.requestedAmount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Total Deductions</span>
                <span className="text-red-400">-{formatCurrency(composedDecision.rationale.math.totalDeductions)}</span>
              </div>
              <div className="flex justify-between font-semibold pt-1 border-t border-white/10">
                <span className="text-gray-300">Adjusted Payout</span>
                <span className="text-green-400">{formatCurrency(composedDecision.rationale.math.adjustedAmount)}</span>
              </div>
            </div>

            {composedDecision.rationale.riskFactors.length > 0 && (
              <div>
                <h5 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">Risk Factors</h5>
                <ul className="list-disc list-inside space-y-0.5 text-xs text-yellow-400">
                  {composedDecision.rationale.riskFactors.map((f, i) => <li key={i}>{f}</li>)}
                </ul>
              </div>
            )}

            <div className="flex items-center justify-between pt-3 border-t border-white/10">
              <Button variant="secondary" size="sm" onClick={handleGenerateEvidence} disabled={evidenceLoading}>
                {evidenceLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <FileText className="mr-1.5 h-3.5 w-3.5" />}
                Generate Evidence Pack
              </Button>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => setConfirmAction(null)}>Cancel</Button>
                <Button
                  variant={confirmAction === 'approve' ? 'success' : 'danger'}
                  size="sm"
                  onClick={handleConfirmFinalAction}
                  disabled={!!finalActionLoading}
                >
                  {finalActionLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  Confirm {confirmAction === 'approve' ? 'Approval' : 'Rejection'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
