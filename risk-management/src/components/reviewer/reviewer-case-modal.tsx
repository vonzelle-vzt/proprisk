'use client';

import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ReviewedCase } from './reviewer-case-table';

interface ReviewerCaseModalProps {
  item: ReviewedCase | null;
  isOpen: boolean;
  onClose: () => void;
}

function getReviewerVariant(status: string): 'green' | 'yellow' | 'red' | 'silver' {
  switch (status) {
    case 'deduction_confirmed': return 'green';
    case 'pending_deduction': return 'yellow';
    case 'review_error': return 'red';
    default: return 'silver';
  }
}

function getReviewerLabel(status: string): string {
  switch (status) {
    case 'deduction_confirmed': return 'Deduction Confirmed';
    case 'pending_deduction': return 'Needs Deduction';
    case 'review_error': return 'Review Error';
    default: return status;
  }
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

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ReviewerCaseModal({ item, isOpen, onClose }: ReviewerCaseModalProps) {
  if (!item) return null;

  const details = item.recommendation_details;
  const login = details?.login;
  const plan = details?.plan || details?.account_context?.plan;
  const startingBalance = details?.starting_balance || details?.account_context?.balance;
  const tradeCount = details?.flagged_trade_count;
  const source = details?.source;
  const severityFactors = details?.severity_factors;
  const execResult = item.execution_result as Record<string, unknown> | null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Review Detail" size="lg">
      <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
        {/* Header */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm text-white">{item.account_id}</span>
          {login && (
            <span className="font-mono text-xs text-gray-400">Login: {login}</span>
          )}
          <Badge variant={getViolationVariant(item.violation_type)}>
            {item.violation_type}
          </Badge>
          <Badge variant={getReviewerVariant(item.reviewer_status)}>
            {getReviewerLabel(item.reviewer_status)}
          </Badge>
          <Badge variant={getEscalationVariant(item.escalation_level)}>
            {item.escalation_level}
          </Badge>
        </div>

        {/* Account & Enforcement Details */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
          <h4 className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-2">
            Account Details
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-y-2 gap-x-4">
            {login && (
              <div>
                <span className="text-[10px] text-gray-500 block">Login</span>
                <span className="text-xs text-white font-mono">{login}</span>
              </div>
            )}
            {plan && (
              <div>
                <span className="text-[10px] text-gray-500 block">Plan</span>
                <span className="text-xs text-white">{plan}</span>
              </div>
            )}
            {startingBalance != null && (
              <div>
                <span className="text-[10px] text-gray-500 block">Starting Balance</span>
                <span className="text-xs text-white font-mono">{formatCurrency(startingBalance)}</span>
              </div>
            )}
            {tradeCount != null && (
              <div>
                <span className="text-[10px] text-gray-500 block">Flagged Trades</span>
                <span className="text-xs text-white font-mono">{tradeCount}</span>
              </div>
            )}
            {source && (
              <div>
                <span className="text-[10px] text-gray-500 block">Source</span>
                <span className="text-xs text-gray-300">{source.replace(/_/g, ' ')}</span>
              </div>
            )}
            <div>
              <span className="text-[10px] text-gray-500 block">Prior Violations</span>
              <span className="text-xs text-white font-mono">{item.prior_violation_count}</span>
            </div>
            {item.repeat_multiplier > 1 && (
              <div>
                <span className="text-[10px] text-gray-500 block">Repeat Multiplier</span>
                <span className="text-xs text-red-400 font-mono">{item.repeat_multiplier}x</span>
              </div>
            )}
          </div>
        </div>

        {/* Enforcement Decision */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
          <h4 className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-2">
            Enforcement Decision
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-y-2 gap-x-4">
            <div>
              <span className="text-[10px] text-gray-500 block">Deduction Amount</span>
              <span className="text-sm text-white font-mono font-medium">{formatCurrency(item.recommended_amount)}</span>
            </div>
            <div>
              <span className="text-[10px] text-gray-500 block">Severity</span>
              <span className={`text-sm font-bold ${
                item.severity_score >= 70 ? 'text-red-400' :
                item.severity_score >= 50 ? 'text-yellow-400' :
                item.severity_score >= 25 ? 'text-blue-400' : 'text-gray-400'
              }`}>{item.severity_score}/100</span>
            </div>
            <div>
              <span className="text-[10px] text-gray-500 block">Status</span>
              <Badge variant={item.status === 'executed' ? 'green' : item.status === 'approved' ? 'blue' : 'silver'}>
                {item.status}
              </Badge>
            </div>
            <div>
              <span className="text-[10px] text-gray-500 block">Decided By</span>
              <span className="text-xs text-gray-300">{item.decided_by || '—'}</span>
            </div>
          </div>
          {item.recommendation_reason && (
            <div className="mt-2 pt-2 border-t border-white/5">
              <span className="text-[10px] text-gray-500 block">Reason</span>
              <span className="text-xs text-gray-300">{item.recommendation_reason}</span>
            </div>
          )}
          {severityFactors && severityFactors.length > 0 && (
            <div className="mt-2 pt-2 border-t border-white/5">
              <span className="text-[10px] text-gray-500 block mb-1">Severity Factors</span>
              <div className="flex flex-wrap gap-1">
                {severityFactors.map((f, i) => (
                  <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-gray-300">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Execution Result */}
        {execResult && (
          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <h4 className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-2">
              Execution Result
            </h4>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="text-[10px] text-gray-500 block">Success</span>
                <Badge variant={execResult.success ? 'green' : 'red'}>
                  {execResult.success ? 'Yes' : 'No'}
                </Badge>
              </div>
              {execResult.deduction_id ? (
                <div>
                  <span className="text-[10px] text-gray-500 block">Deduction ID</span>
                  <span className="text-[10px] text-gray-300 font-mono">{String(execResult.deduction_id).slice(0, 12)}...</span>
                </div>
              ) : null}
              {execResult.error ? (
                <div className="col-span-2">
                  <span className="text-[10px] text-gray-500 block">Error</span>
                  <span className="text-[10px] text-red-400">{String(execResult.error)}</span>
                </div>
              ) : null}
            </div>
          </div>
        )}

        {/* Reviewer Verification */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
          <h4 className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-2">
            Reviewer Verification
          </h4>
          <div className="mb-2">
            <p className="text-xs text-gray-300 leading-relaxed">
              {item.reviewer_status === 'deduction_confirmed'
                ? 'The reviewer agent verified this deduction was applied on the Trading Platform. The amount in the violation summary or ledger events matches the enforcement amount.'
                : item.reviewer_status === 'pending_deduction'
                ? 'The reviewer agent could not find a matching deduction on the Trading Platform. The deduction may not have been applied yet, or the amount does not match.'
                : item.reviewer_status === 'review_error'
                ? 'The reviewer agent encountered an error checking this case against the Trading Platform. Could be an API issue or timeout. Will be retried next run.'
                : 'This case has not been reviewed yet.'}
            </p>
          </div>
          {item.reviewer_notes && (
            <details className="mt-2">
              <summary className="text-[10px] text-gray-400 cursor-pointer hover:text-gray-300">
                Show raw verification log
              </summary>
              <pre className="mt-2 text-[10px] text-gray-400 whitespace-pre-wrap font-mono bg-black/30 rounded-lg p-3 max-h-48 overflow-y-auto leading-relaxed">
                {item.reviewer_notes}
              </pre>
            </details>
          )}
        </div>

        {/* Timeline */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[11px] text-gray-500 border-t border-white/10 pt-3">
          <span>Created: {formatDateTime(item.created_at)}</span>
          {item.decided_at && <span>Decided: {formatDateTime(item.decided_at)}</span>}
          <span>Reviewed: {formatDateTime(item.reviewed_at)}</span>
        </div>

        {/* Close */}
        <div className="flex items-center justify-end pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
