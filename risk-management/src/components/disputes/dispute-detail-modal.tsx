'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { formatCurrency, formatDateTime } from '@/lib/utils/format';
import type { Dispute, DisputeStatus } from '@/lib/disputes/types';
import type { EvidencePack } from '@/lib/evidence/types';
import { ExternalLink } from 'lucide-react';

interface DisputeDetailModalProps {
  dispute: Dispute | null;
  isOpen: boolean;
  onClose: () => void;
  onChanged: () => void;
}

const STATUS_LABEL: Record<DisputeStatus, string> = {
  open: 'Open',
  under_review: 'Under Review',
  upheld: 'Upheld',
  overturned: 'Overturned',
  withdrawn: 'Withdrawn',
};

const resolveOptions = [
  { value: 'upheld', label: 'Upheld — original decision stands' },
  { value: 'overturned', label: 'Overturned — reverse the decision' },
  { value: 'withdrawn', label: 'Withdrawn — trader dropped the case' },
];

/**
 * Case view: the trader's statement sits beside the evidence pack that was
 * pinned when the decision was made (see src/lib/disputes/lifecycle.ts
 * `pinEvidencePack`), so a reviewer resolves the dispute against exactly
 * what the decision was based on — not today's rules.
 */
export function DisputeDetailModal({ dispute, isOpen, onClose, onChanged }: DisputeDetailModalProps) {
  const [pack, setPack] = useState<EvidencePack | null>(null);
  const [packLoading, setPackLoading] = useState(false);
  const [packError, setPackError] = useState<string | null>(null);

  const [resolveStatus, setResolveStatus] = useState<'upheld' | 'overturned' | 'withdrawn'>('upheld');
  const [resolution, setResolution] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setPack(null);
    setPackError(null);
    setResolution('');
    setActionError(null);
    if (!isOpen || !dispute?.evidencePackId) return;

    let cancelled = false;
    setPackLoading(true);
    fetch(`/api/evidence/${dispute.evidencePackId}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) setPack(json.data ?? null);
      })
      .catch((err) => {
        if (!cancelled) setPackError(err instanceof Error ? err.message : 'Failed to load evidence pack');
      })
      .finally(() => {
        if (!cancelled) setPackLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, dispute?.evidencePackId]);

  if (!dispute) return null;

  const transition = async (status: DisputeStatus, res?: string) => {
    setSubmitting(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/disputes/${dispute.id}/transition`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, resolution: res }),
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        setActionError(errData.error || `Failed to update dispute (${response.status})`);
        return;
      }
      onChanged();
      onClose();
    } catch (err: any) {
      setActionError(err?.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const isOpenStatus = dispute.status === 'open';
  const isUnderReview = dispute.status === 'under_review';
  const canResolve = isOpenStatus || isUnderReview;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Dispute" size="xl">
      <div className="space-y-5">
        {actionError && (
          <div className="rounded-lg border border-red-500/50 bg-red-900/30 px-3 py-2 text-xs text-red-300">
            {actionError}
          </div>
        )}

        {/* Header */}
        <div className="flex items-center gap-3 flex-wrap">
          <Badge variant="default">{dispute.subjectType}</Badge>
          <span className="font-mono text-xs text-gray-400">{dispute.subjectId}</span>
          {dispute.accountId && <span className="font-mono text-xs text-gray-500">acct {dispute.accountId}</span>}
          <Badge variant="silver">{STATUS_LABEL[dispute.status]}</Badge>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Trader statement */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <h4 className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-2">
              Trader Statement
            </h4>
            <p className="text-xs text-gray-500 mb-1">Raised by {dispute.raisedBy} · {formatDateTime(dispute.raisedAt)}</p>
            <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">{dispute.traderStatement}</p>
          </div>

          {/* Evidence pack, pinned at open time */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
                Evidence Pack (as of decision time)
              </h4>
              {dispute.evidencePackId && (
                <Link
                  href={`/evidence/${dispute.evidencePackId}`}
                  target="_blank"
                  className="text-[10px] text-gray-400 hover:text-gray-200 inline-flex items-center gap-1"
                >
                  Full pack <ExternalLink className="h-3 w-3" />
                </Link>
              )}
            </div>
            {!dispute.evidencePackId && (
              <p className="text-xs text-red-400">No evidence pack could be attached for this subject.</p>
            )}
            {packLoading && <p className="text-xs text-gray-500">Loading evidence pack...</p>}
            {packError && <p className="text-xs text-red-400">{packError}</p>}
            {pack && (
              <div className="space-y-2">
                <p className="text-xs text-gray-300 leading-relaxed line-clamp-4">{pack.narrative}</p>
                {pack.sections.scoringTrail.length > 0 && (
                  <ul className="space-y-1">
                    {pack.sections.scoringTrail.map((f) => (
                      <li key={f.ruleId} className="flex items-center justify-between text-[11px]">
                        <span className="text-gray-300">{f.ruleLabel}</span>
                        <span className="text-red-400 font-medium">-{formatCurrency(f.deductionAmount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Resolution (already resolved) */}
        {dispute.resolution && (
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <h4 className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-1">Resolution</h4>
            <p className="text-xs text-gray-500 mb-1">
              {dispute.resolvedBy} · {dispute.resolvedAt ? formatDateTime(dispute.resolvedAt) : ''}
            </p>
            <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">{dispute.resolution}</p>
          </div>
        )}

        {/* Actions */}
        {canResolve && (
          <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
            <h4 className="text-[10px] font-medium uppercase tracking-wider text-gray-400">Resolve</h4>
            <div className="flex flex-wrap items-center gap-2">
              {isOpenStatus && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => transition('under_review')}
                  loading={submitting}
                  disabled={submitting}
                >
                  Move to Under Review
                </Button>
              )}
              <Select value={resolveStatus} onChange={(v) => setResolveStatus(v as any)} options={resolveOptions} />
            </div>
            <textarea
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              rows={3}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-gray-200 outline-none focus:border-red-500/50 resize-none"
              placeholder="Written resolution — required to resolve a dispute."
            />
            <div className="flex justify-end">
              <Button
                variant={resolveStatus === 'overturned' ? 'danger' : 'primary'}
                size="sm"
                onClick={() => transition(resolveStatus, resolution)}
                loading={submitting}
                disabled={submitting || !resolution.trim()}
              >
                Resolve as {STATUS_LABEL[resolveStatus]}
              </Button>
            </div>
          </div>
        )}

        <div className="flex justify-end pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
