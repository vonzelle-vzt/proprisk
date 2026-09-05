'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import type { DisputeSubjectType } from '@/lib/disputes/types';

interface OpenDisputeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpened: () => void;
}

const subjectTypeOptions = [
  { value: 'breach', label: 'Breach' },
  { value: 'payout', label: 'Payout' },
  { value: 'deduction', label: 'Deduction' },
];

/**
 * Opens a dispute from the firm's side, on a trader's behalf — there is no
 * trader-facing portal yet, so a risk-team member files the case here and
 * records the trader's own statement verbatim.
 */
export function OpenDisputeModal({ isOpen, onClose, onOpened }: OpenDisputeModalProps) {
  const [subjectType, setSubjectType] = useState<DisputeSubjectType>('breach');
  const [subjectId, setSubjectId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [raisedBy, setRaisedBy] = useState('');
  const [traderStatement, setTraderStatement] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setSubjectType('breach');
    setSubjectId('');
    setAccountId('');
    setRaisedBy('');
    setTraderStatement('');
    setError(null);
  };

  const handleSubmit = async () => {
    if (!subjectId.trim() || !raisedBy.trim() || !traderStatement.trim()) {
      setError('Subject ID, raised by, and the trader statement are all required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/disputes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subjectType,
          subjectId: subjectId.trim(),
          accountId: accountId.trim() || undefined,
          raisedBy: raisedBy.trim(),
          traderStatement: traderStatement.trim(),
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setError(errData.error || `Failed to open dispute (${res.status})`);
        return;
      }
      reset();
      onOpened();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={() => { reset(); onClose(); }} title="Open Dispute" size="md">
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg border border-red-500/50 bg-red-900/30 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Subject Type</label>
          <Select
            value={subjectType}
            onChange={(v) => setSubjectType(v as DisputeSubjectType)}
            options={subjectTypeOptions}
            className="w-full"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            Subject ID <span className="text-gray-600">(violation / payout / deduction id)</span>
          </label>
          <input
            value={subjectId}
            onChange={(e) => setSubjectId(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-gray-200 outline-none focus:border-red-500/50"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Account ID</label>
          <input
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-gray-200 outline-none focus:border-red-500/50"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Raised By (trader name)</label>
          <input
            value={raisedBy}
            onChange={(e) => setRaisedBy(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-gray-200 outline-none focus:border-red-500/50"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Trader Statement</label>
          <textarea
            value={traderStatement}
            onChange={(e) => setTraderStatement(e.target.value)}
            rows={5}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-gray-200 outline-none focus:border-red-500/50 resize-none"
            placeholder="Record what the trader said, as they said it."
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={() => { reset(); onClose(); }}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleSubmit} loading={submitting} disabled={submitting}>
            Open Dispute
          </Button>
        </div>
      </div>
    </Modal>
  );
}
