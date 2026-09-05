'use client';

import { useEffect, useState } from 'react';
import { EnforcementRecommendation } from '@/types/enforcement';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';

interface FlaggedTrade {
  tradeId: string;
  type: string;
  typeLabel: string;
  explanation: string;
  deductionAmount: number;
  symbol: string;
  side: string;
  lots: number;
  openTime: string;
  closeTime: string;
  openPrice: number;
  closePrice: number;
  duration: number;
  profit: number;
  commission: number;
  swap: number;
  stopLoss: number;
  takeProfit: number;
}

interface EnforcementDetailModalProps {
  item: EnforcementRecommendation | null;
  isOpen: boolean;
  onClose: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  actionLoadingId?: string | null;
}

const violationBadgeVariant: Record<string, 'purple' | 'red' | 'yellow' | 'blue' | 'green' | 'silver'> = {
  copy: 'purple',
  martingale: 'red',
  grid: 'yellow',
  hft: 'blue',
  news: 'green',
};

function getViolationVariant(type: string) {
  return violationBadgeVariant[type] ?? 'silver';
}

function getEscalationVariant(level: string): 'red' | 'yellow' | 'blue' | 'silver' {
  switch (level) {
    case 'critical': return 'red';
    case 'urgent': return 'yellow';
    case 'elevated': return 'blue';
    default: return 'silver';
  }
}

function getSeverityBarColor(score: number): string {
  if (score >= 70) return 'bg-red-500';
  if (score >= 50) return 'bg-yellow-500';
  if (score >= 25) return 'bg-blue-500';
  return 'bg-gray-500';
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatShortTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function EnforcementDetailModal({
  item,
  isOpen,
  onClose,
  onApprove,
  onReject,
  actionLoadingId,
}: EnforcementDetailModalProps) {
  const [flaggedTrades, setFlaggedTrades] = useState<FlaggedTrade[]>([]);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [tradesError, setTradesError] = useState<string | null>(null);
  const [enforceLoading, setEnforceLoading] = useState<string | null>(null);
  const [enforceMsg, setEnforceMsg] = useState<string | null>(null);

  async function runEnforce(action: 'restrict' | 'suspend' | 'flatten') {
    if (!item) return;
    setEnforceLoading(action);
    setEnforceMsg(null);
    try {
      const res = await fetch('/api/providers/enforce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: item.account_id, action }),
      });
      const json = await res.json();
      setEnforceMsg(json.message || (json.ok ? 'Action sent.' : 'Action failed.'));
    } catch {
      setEnforceMsg('Action failed — network error.');
    } finally {
      setEnforceLoading(null);
    }
  }

  useEffect(() => {
    if (!isOpen || !item) {
      setFlaggedTrades([]);
      setTradesError(null);
      return;
    }

    let cancelled = false;
    async function fetchTrades() {
      setTradesLoading(true);
      setTradesError(null);
      try {
        const res = await fetch(`/api/platform/violations/${item!.account_id}`, { cache: 'no-store' });
        if (!res.ok) {
          setTradesError(`Failed to load trades (${res.status})`);
          return;
        }
        const data = await res.json();
        if (cancelled) return;

        // Filter flagged trades to only the violation type in this enforcement item
        const allFlagged: FlaggedTrade[] = data.flaggedTrades ?? [];
        const filtered = allFlagged.filter((t) => t.type === item!.violation_type);
        setFlaggedTrades(filtered.length > 0 ? filtered : allFlagged);
      } catch {
        if (!cancelled) setTradesError('Failed to load trade data');
      } finally {
        if (!cancelled) setTradesLoading(false);
      }
    }

    fetchTrades();
    return () => { cancelled = true; };
  }, [isOpen, item]);

  if (!item) return null;

  const details = item.recommendation_details;
  const context = details?.account_context;
  // Use details from the cron source (login, plan, starting_balance) when account_context is missing
  const detailsAny = details as unknown as Record<string, unknown> | undefined;
  const displayLogin = detailsAny?.login as string | undefined;
  const displayPlan = context?.plan ?? (detailsAny?.plan as string | undefined);
  const displayBalance = context?.balance ?? (detailsAny?.starting_balance as number | undefined);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Enforcement Detail" size="lg">
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-mono text-sm text-white">{item.account_id}</span>
          {displayLogin && (
            <span className="font-mono text-sm text-gray-400">({displayLogin})</span>
          )}
          <Badge variant={getViolationVariant(item.violation_type)}>
            {item.violation_type}
          </Badge>
          <Badge variant={getEscalationVariant(item.escalation_level)}>
            {item.escalation_level}
          </Badge>
          <Badge variant="default">{item.action_type.replace('_', ' ')}</Badge>
        </div>

        {/* Severity Score Bar */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
              Severity Score
            </span>
            <span className={cn(
              'text-sm font-bold',
              item.severity_score >= 70 ? 'text-red-400' :
              item.severity_score >= 50 ? 'text-yellow-400' :
              item.severity_score >= 25 ? 'text-blue-400' : 'text-gray-400'
            )}>
              {item.severity_score}/100
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', getSeverityBarColor(item.severity_score))}
              style={{ width: `${Math.min(item.severity_score, 100)}%` }}
            />
          </div>
        </div>

        {/* Severity Factors */}
        {details?.severity_factors && details.severity_factors.length > 0 && (
          <div>
            <h4 className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-2">
              Severity Factors
            </h4>
            <ul className="space-y-1">
              {details.severity_factors.map((factor, idx) => (
                <li key={idx} className="flex items-start gap-2 text-xs text-gray-300">
                  <span className="mt-1 h-1 w-1 rounded-full bg-red-400 shrink-0" />
                  {factor}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Recommended Amount Breakdown */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
          <h4 className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-2">
            Recommended Amount
          </h4>
          <div className="text-xl font-bold text-white mb-2">
            {formatCurrency(item.recommended_amount)}
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span>Base: {formatCurrency(details?.base_amount ?? 0)}</span>
            <span className="text-gray-600">x</span>
            <span>Multiplier: {details?.repeat_multiplier ?? item.repeat_multiplier}x</span>
          </div>
        </div>

        {/* Account Context */}
        {(context || displayPlan || displayBalance != null) && (
          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <h4 className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-2">
              Account Context
            </h4>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <span className="text-[10px] text-gray-500 block">Plan</span>
                <span className="text-xs text-white font-medium">{displayPlan ?? '—'}</span>
              </div>
              <div>
                <span className="text-[10px] text-gray-500 block">Balance</span>
                <span className="text-xs text-white font-medium">
                  {displayBalance != null ? formatCurrency(displayBalance) : '—'}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-gray-500 block">Prior Deductions</span>
                <span className="text-xs text-white font-medium">
                  {context?.total_prior_deductions != null ? formatCurrency(context.total_prior_deductions) : '—'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Flagged Trades */}
        <div>
          <h4 className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-2">
            Flagged Trades ({tradesLoading ? '...' : flaggedTrades.length})
          </h4>
          {tradesLoading && (
            <div className="text-xs text-gray-500 py-3 text-center">Loading trade data...</div>
          )}
          {tradesError && (
            <div className="text-xs text-red-400 py-2">{tradesError}</div>
          )}
          {!tradesLoading && !tradesError && flaggedTrades.length === 0 && (
            <div className="text-xs text-gray-500 py-2">No flagged trades found for this account.</div>
          )}
          {flaggedTrades.length > 0 && (
            <div className="rounded-xl border border-white/10 overflow-hidden">
              <div className="overflow-x-auto max-h-60 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-black/80 backdrop-blur-sm">
                    <tr className="text-[10px] text-gray-500 uppercase tracking-wider">
                      <th className="text-left px-2 py-1.5">Symbol</th>
                      <th className="text-left px-2 py-1.5">Side</th>
                      <th className="text-right px-2 py-1.5">Lots</th>
                      <th className="text-right px-2 py-1.5">Profit</th>
                      <th className="text-right px-2 py-1.5">Deduction</th>
                      <th className="text-left px-2 py-1.5">Type</th>
                      <th className="text-left px-2 py-1.5">Opened</th>
                      <th className="text-left px-2 py-1.5">Closed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {flaggedTrades.map((trade, idx) => (
                      <tr key={trade.tradeId ?? idx} className="hover:bg-white/5 transition-colors">
                        <td className="px-2 py-1.5 font-mono text-white">{trade.symbol}</td>
                        <td className="px-2 py-1.5">
                          <span className={trade.side === 'buy' ? 'text-green-400' : 'text-red-400'}>
                            {trade.side?.toUpperCase()}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right text-gray-300">{trade.lots}</td>
                        <td className={cn(
                          'px-2 py-1.5 text-right font-medium',
                          trade.profit >= 0 ? 'text-green-400' : 'text-red-400'
                        )}>
                          {formatCurrency(trade.profit)}
                        </td>
                        <td className="px-2 py-1.5 text-right text-red-400 font-medium">
                          -{formatCurrency(trade.deductionAmount)}
                        </td>
                        <td className="px-2 py-1.5">
                          <Badge variant={getViolationVariant(trade.type)} className="text-[9px] px-1.5 py-0">
                            {trade.typeLabel}
                          </Badge>
                        </td>
                        <td className="px-2 py-1.5 text-gray-400 whitespace-nowrap">
                          {trade.openTime ? formatShortTime(trade.openTime) : '—'}
                        </td>
                        <td className="px-2 py-1.5 text-gray-400 whitespace-nowrap">
                          {trade.closeTime ? formatShortTime(trade.closeTime) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-white/10 bg-white/5">
                    <tr className="text-xs font-medium">
                      <td colSpan={4} className="px-2 py-1.5 text-gray-400 text-right">
                        Total Deductions:
                      </td>
                      <td className="px-2 py-1.5 text-right text-red-400 font-bold">
                        -{formatCurrency(flaggedTrades.reduce((sum, t) => sum + (t.deductionAmount ?? 0), 0))}
                      </td>
                      <td colSpan={3} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Violation History */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className="text-[10px] text-gray-500 block">Prior Violations</span>
            <span className="text-sm text-white font-medium">{item.prior_violation_count}</span>
          </div>
          <div>
            <span className="text-[10px] text-gray-500 block">Repeat Multiplier</span>
            <span className="text-sm text-white font-medium">{item.repeat_multiplier}x</span>
          </div>
        </div>

        {/* Reason */}
        <div>
          <h4 className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-1">
            Reason
          </h4>
          <p className="text-xs text-gray-300 leading-relaxed">{item.recommendation_reason}</p>
        </div>

        {/* Reviewer Report */}
        {item.reviewer_status && (
          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <h4 className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-2">
              Reviewer Report
            </h4>
            <div className="flex items-center gap-2 mb-2">
              <Badge variant={
                item.reviewer_status === 'deduction_confirmed' ? 'green' :
                item.reviewer_status === 'pending_deduction' ? 'yellow' :
                item.reviewer_status === 'review_error' ? 'red' : 'silver'
              }>
                {item.reviewer_status === 'deduction_confirmed' ? 'Deduction Confirmed' :
                 item.reviewer_status === 'pending_deduction' ? 'Needs Deduction' :
                 item.reviewer_status === 'review_error' ? 'Review Error' :
                 item.reviewer_status}
              </Badge>
              {item.reviewed_at && (
                <span className="text-[10px] text-gray-500">
                  Reviewed: {formatDateTime(item.reviewed_at)}
                </span>
              )}
            </div>
            {item.reviewer_notes && (
              <pre className="text-[11px] text-gray-300 whitespace-pre-wrap font-mono bg-black/30 rounded-lg p-2 max-h-40 overflow-y-auto">
                {item.reviewer_notes}
              </pre>
            )}
          </div>
        )}

        {/* Platform Enforcement — acts on the owning trading platform via its adapter */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
          <h4 className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-2">
            Platform Enforcement
          </h4>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => runEnforce('restrict')} loading={enforceLoading === 'restrict'} disabled={!!enforceLoading}>
              Restrict (close-only)
            </Button>
            <Button variant="secondary" size="sm" onClick={() => runEnforce('suspend')} loading={enforceLoading === 'suspend'} disabled={!!enforceLoading}>
              Suspend
            </Button>
            <Button variant="danger" size="sm" onClick={() => runEnforce('flatten')} loading={enforceLoading === 'flatten'} disabled={!!enforceLoading}>
              Flatten positions
            </Button>
          </div>
          {enforceMsg && <p className="mt-2 text-[11px] text-gray-400">{enforceMsg}</p>}
        </div>

        {/* Timestamps */}
        <div className="flex items-center gap-6 text-[11px] text-gray-500 border-t border-white/10 pt-3">
          <span>Created: {formatDateTime(item.created_at)}</span>
          <span>Expires: {formatDateTime(item.expires_at)}</span>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => onReject(item.id)}
            disabled={item.status !== 'pending' || actionLoadingId === item.id}
            loading={actionLoadingId === item.id}
          >
            Reject
          </Button>
          <Button
            variant="success"
            size="sm"
            onClick={() => onApprove(item.id)}
            disabled={item.status !== 'pending' || actionLoadingId === item.id}
            loading={actionLoadingId === item.id}
          >
            Approve
          </Button>
        </div>
      </div>
    </Modal>
  );
}
