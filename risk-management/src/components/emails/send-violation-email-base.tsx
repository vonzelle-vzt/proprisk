'use client';

import { useState, useEffect } from 'react';
import { Mail, CheckCircle, Loader2, AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { VIOLATION_LABELS } from '@/lib/violations/labels';

interface ViolationEntry {
  typeKey: string;
  label: string;
  deductionAmount: number;
}

interface PriorSendRecord {
  id: string;
  sent_at: string;
  sent_by: string;
  recipient: string;
}

interface Props {
  accountId: string;
  login: string;
  traderName: string;
  traderEmail: string;
  violations: ViolationEntry[];
  payoutAmount?: number;
  totalDeductions?: number;
  phaseLabel?: string;
  retryAccountId?: string;
  onRetryAccountIdChange?: (value: string) => void;
  isOpen: boolean;
  onClose: () => void;
  onSend: (selectedViolations: ViolationEntry[], retryAccountId?: string) => Promise<void>;
  apiEndpoint: string;
  emailCheckEndpoint: string;
  modalTitle?: string;
}

export function SendViolationEmailBase({
  accountId,
  login,
  traderName,
  traderEmail,
  violations,
  payoutAmount,
  totalDeductions,
  phaseLabel,
  retryAccountId: externalRetryAccountId,
  onRetryAccountIdChange,
  isOpen,
  onClose,
  onSend,
  apiEndpoint,
  emailCheckEndpoint,
  modalTitle,
}: Props) {
  const [retryAccountId, setRetryAccountId] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkingPrior, setCheckingPrior] = useState(false);
  const [priorSend, setPriorSend] = useState<PriorSendRecord | null>(null);

  // On open: reset state and check for a prior send
  useEffect(() => {
    if (!isOpen) return;
    setChecked(new Set(violations.map((v) => v.typeKey)));
    setRetryAccountId('');
    setSent(false);
    setError(null);
    setPriorSend(null);

    setCheckingPrior(true);
    fetch(`${emailCheckEndpoint}?accountId=${accountId}`)
      .then((r) => r.json())
      .then((data) => {
        setPriorSend(data.record || null);
      })
      .catch(() => { /* non-critical, proceed without check */ })
      .finally(() => setCheckingPrior(false));
  }, [isOpen, accountId, violations, emailCheckEndpoint]);

  const toggleViolation = (typeKey: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(typeKey)) next.delete(typeKey);
      else next.add(typeKey);
      return next;
    });
  };

  const selectedViolations = violations.filter((v) => checked.has(v.typeKey));
  const hasRetryAccountField = externalRetryAccountId !== undefined;
  const canSend = !priorSend
    && selectedViolations.length > 0
    && !sending
    && !checkingPrior
    && (!hasRetryAccountField || retryAccountId.trim().length > 0);

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);

    try {
      await onSend(selectedViolations, retryAccountId || undefined);
      setSent(true);
      setTimeout(() => onClose(), 1500);
    } catch (err: any) {
      setError(err.message || 'Failed to send email');
    } finally {
      setSending(false);
    }
  };

  const formatSentAt = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  const title = modalTitle || `Send Violation Email — Login: ${login}`;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm">
      {sent ? (
        <div className="flex flex-col items-center justify-center py-6 gap-3">
          <CheckCircle className="h-10 w-10 text-green-400" />
          <p className="text-sm text-green-400 font-medium">Email sent successfully</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Recipient */}
          <div>
            <p className="text-[11px] text-gray-500 uppercase tracking-wider font-semibold mb-1">Recipient</p>
            <p className="text-[13px] text-gray-300 font-mono">{traderEmail || '—'}</p>
          </div>

          {/* Prior-send warning */}
          {checkingPrior ? (
            <div className="flex items-center gap-2 text-[11px] text-gray-500">
              <Loader2 className="h-3 w-3 animate-spin" /> Checking email history...
            </div>
          ) : priorSend ? (
            <div className="flex items-start gap-2.5 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2.5">
              <AlertTriangle className="h-3.5 w-3.5 text-yellow-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-[12px] text-yellow-300 font-medium">Email already sent</p>
                <p className="text-[11px] text-yellow-400/80 mt-0.5">
                  Sent on {formatSentAt(priorSend.sent_at)}
                  {priorSend.sent_by ? ` by ${priorSend.sent_by}` : ''}.
                  Sending again is blocked to prevent duplicates.
                </p>
              </div>
            </div>
          ) : null}

          {/* Payout info (if payoutAmount provided) */}
          {payoutAmount !== undefined && totalDeductions !== undefined && (
            <div className="flex gap-4">
              <div>
                <p className="text-[11px] text-gray-500 uppercase tracking-wider font-semibold mb-1">Payout Amount</p>
                <p className="text-[13px] text-gray-300 font-mono">${payoutAmount.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-[11px] text-gray-500 uppercase tracking-wider font-semibold mb-1">Total Deductions</p>
                <p className="text-[13px] text-red-400 font-mono">${totalDeductions.toFixed(2)}</p>
              </div>
              {totalDeductions >= payoutAmount && (
                <div className="flex items-end">
                  <span className="text-[11px] text-red-400 font-medium">Payout will be rejected</span>
                </div>
              )}
            </div>
          )}

          {/* Violations checkboxes */}
          <div>
            <p className="text-[11px] text-gray-500 uppercase tracking-wider font-semibold mb-2">
              Violations to include
            </p>
            {violations.length === 0 ? (
              <p className="text-[12px] text-gray-500">No violations detected.</p>
            ) : (
              <div className="space-y-2">
                {violations.map((v) => (
                  <label
                    key={v.typeKey}
                    className="flex items-center justify-between gap-3 cursor-pointer rounded-lg border border-white/10 bg-black/20 px-3 py-2 hover:bg-white/5 transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <input
                        type="checkbox"
                        checked={checked.has(v.typeKey)}
                        onChange={() => toggleViolation(v.typeKey)}
                        disabled={!!priorSend}
                        className="h-3.5 w-3.5 accent-red-500 cursor-pointer disabled:cursor-not-allowed"
                      />
                      <span className="text-[12px] text-gray-200">{v.label}</span>
                    </div>
                    <span className="text-[12px] text-red-400 font-medium tabular-nums">
                      ${v.deductionAmount.toFixed(2)}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Retry account input (if retryAccountId prop provided) */}
          {externalRetryAccountId !== undefined && (
            <div>
              <label className="block text-[11px] text-gray-500 uppercase tracking-wider font-semibold mb-1.5">
                New Retry Account Number
              </label>
              <input
                type="text"
                value={retryAccountId}
                onChange={(e) => {
                  setRetryAccountId(e.target.value);
                  onRetryAccountIdChange?.(e.target.value);
                }}
                disabled={!!priorSend}
                placeholder="e.g. 1234567"
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[13px] text-gray-200 placeholder-gray-600 focus:border-white/30 focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
          )}

          {/* Error */}
          {error && <p className="text-[12px] text-red-400">{error}</p>}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="px-4 py-2 text-[12px] font-medium text-gray-400 hover:text-white rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 transition-colors"
            >
              {priorSend ? 'Close' : 'Cancel'}
            </button>
            {!priorSend && (
              <button
                onClick={handleSend}
                disabled={!canSend}
                className="flex items-center gap-1.5 px-4 py-2 text-[12px] font-medium rounded-lg bg-red-600/80 hover:bg-red-600 text-white border border-red-500/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {sending ? (
                  <><Loader2 className="h-3 w-3 animate-spin" /> Sending...</>
                ) : (
                  <><Mail className="h-3 w-3" /> Send Email</>
                )}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
