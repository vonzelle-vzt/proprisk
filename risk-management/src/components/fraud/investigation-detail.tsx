'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import type { FraudInvestigation, FraudStatus, FraudType } from '@/types/fraud';

interface InvestigationDetailProps {
  investigation: FraudInvestigation | null;
  isOpen: boolean;
  onClose: () => void;
  onUpdateStatus: (id: string, status: FraudStatus) => void;
}

const fraudTypeBadge: Record<FraudType, { label: string; variant: 'purple' | 'blue' | 'yellow' | 'red' }> = {
  copy_ring: { label: 'Copy Ring', variant: 'purple' },
  shared_identity: { label: 'Shared Identity', variant: 'blue' },
  coordinated_payout: { label: 'Coordinated Payout', variant: 'yellow' },
  account_churning: { label: 'Account Churning', variant: 'red' },
  profit_manipulation: { label: 'Profit Manipulation', variant: 'red' },
};

const severityBadge: Record<string, 'silver' | 'yellow' | 'red' | 'red'> = {
  low: 'silver',
  medium: 'yellow',
  high: 'red',
  critical: 'red',
};

const statusBadge: Record<string, 'blue' | 'yellow' | 'green' | 'silver' | 'red'> = {
  open: 'blue',
  reviewing: 'yellow',
  confirmed: 'red',
  dismissed: 'silver',
  actioned: 'green',
};

function ConfidenceBar({ score }: { score: number }) {
  const color =
    score >= 80 ? 'from-red-500 to-red-600' :
    score >= 60 ? 'from-yellow-500 to-orange-500' :
    score >= 40 ? 'from-yellow-400 to-yellow-500' :
    'from-emerald-400 to-emerald-500';

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-400">Confidence Score</span>
        <span className="text-white font-semibold">{score}%</span>
      </div>
      <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
        <div
          className={cn('h-full rounded-full bg-gradient-to-r transition-all duration-500', color)}
          style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
        />
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">{children}</h3>;
}

function EvidenceTable({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full">
        <thead>
          <tr className="border-b border-white/10 bg-white/5">
            {headers.map((h) => (
              <th key={h} className="px-2.5 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400 whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className="px-2.5 py-1.5 text-xs text-gray-300 whitespace-nowrap">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CopyRingEvidence({ evidence }: { evidence: FraudInvestigation['evidence'] }) {
  if (!evidence.trade_correlations?.length) return null;
  return (
    <div>
      <SectionTitle>Trade Correlations</SectionTitle>
      <EvidenceTable
        headers={['Symbol', 'Account A', 'Account B', 'Time Lag (s)', 'Lot Ratio', 'Count']}
        rows={evidence.trade_correlations.map((tc) => [
          tc.symbol,
          <span key="a" className="font-mono text-[10px]">{tc.account_a}</span>,
          <span key="b" className="font-mono text-[10px]">{tc.account_b}</span>,
          tc.time_lag_seconds.toFixed(1),
          tc.lot_ratio.toFixed(2),
          tc.count,
        ])}
      />
      {evidence.correlation_score !== undefined && (
        <p className="text-xs text-gray-500 mt-1">Correlation score: {evidence.correlation_score.toFixed(2)}</p>
      )}
    </div>
  );
}

function SharedIdentityEvidence({ evidence }: { evidence: FraudInvestigation['evidence'] }) {
  return (
    <div className="space-y-3">
      {evidence.shared_emails?.length ? (
        <div>
          <SectionTitle>Shared Email Patterns</SectionTitle>
          <ul className="space-y-1">
            {evidence.shared_emails.map((se, i) => (
              <li key={i} className="text-xs text-gray-300 bg-white/5 rounded-lg px-3 py-2">
                <span className="font-mono text-blue-400">{se.pattern}</span>
                <span className="text-gray-500 ml-2">({se.accounts.length} accounts: {se.accounts.join(', ')})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {evidence.shared_names?.length ? (
        <div>
          <SectionTitle>Shared Names</SectionTitle>
          <ul className="space-y-1">
            {evidence.shared_names.map((sn, i) => (
              <li key={i} className="text-xs text-gray-300 bg-white/5 rounded-lg px-3 py-2">
                <span className="text-white font-medium">{sn.name}</span>
                <span className="text-gray-500 ml-2">({sn.accounts.length} accounts: {sn.accounts.join(', ')})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function CoordinatedPayoutEvidence({ evidence }: { evidence: FraudInvestigation['evidence'] }) {
  if (!evidence.payout_cluster?.length) return null;
  return (
    <div>
      <SectionTitle>Payout Cluster Timeline</SectionTitle>
      {evidence.cluster_window_minutes && (
        <p className="text-xs text-gray-500 mb-2">Window: {evidence.cluster_window_minutes} minutes</p>
      )}
      <EvidenceTable
        headers={['Account', 'Requested At', 'Amount']}
        rows={evidence.payout_cluster.map((pc) => [
          <span key="a" className="font-mono text-[10px]">{pc.account_id}</span>,
          new Date(pc.requested_at).toLocaleString(),
          `$${pc.amount.toLocaleString()}`,
        ])}
      />
    </div>
  );
}

function AccountChurningEvidence({ evidence }: { evidence: FraudInvestigation['evidence'] }) {
  if (!evidence.user_accounts?.length) return null;
  return (
    <div>
      <SectionTitle>User Accounts</SectionTitle>
      <EvidenceTable
        headers={['User ID', 'Email', 'Total Accounts', 'Failed', 'Account IDs']}
        rows={evidence.user_accounts.map((ua) => [
          <span key="u" className="font-mono text-[10px]">{ua.user_id}</span>,
          ua.email,
          ua.total_accounts,
          <span key="f" className="text-red-400 font-medium">{ua.failed_accounts}</span>,
          <span key="a" className="font-mono text-[10px] max-w-[200px] truncate block">{ua.account_ids.join(', ')}</span>,
        ])}
      />
    </div>
  );
}

function ProfitManipulationEvidence({ evidence }: { evidence: FraudInvestigation['evidence'] }) {
  if (!evidence.offsetting_trades?.length) return null;
  return (
    <div>
      <SectionTitle>Offsetting Trades</SectionTitle>
      <EvidenceTable
        headers={['Symbol', 'Account A', 'Dir A', 'PnL A', 'Account B', 'Dir B', 'PnL B', 'Net Transfer']}
        rows={evidence.offsetting_trades.map((ot) => [
          ot.symbol,
          <span key="a" className="font-mono text-[10px]">{ot.account_a}</span>,
          ot.account_a_direction,
          <span key="pa" className={cn(ot.account_a_pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>${ot.account_a_pnl.toLocaleString()}</span>,
          <span key="b" className="font-mono text-[10px]">{ot.account_b}</span>,
          ot.account_b_direction,
          <span key="pb" className={cn(ot.account_b_pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>${ot.account_b_pnl.toLocaleString()}</span>,
          <span key="nt" className="text-yellow-400 font-medium">${ot.net_transfer.toLocaleString()}</span>,
        ])}
      />
    </div>
  );
}

export function InvestigationDetail({ investigation, isOpen, onClose, onUpdateStatus }: InvestigationDetailProps) {
  const router = useRouter();
  const [generatingEvidence, setGeneratingEvidence] = useState(false);

  if (!investigation) return null;

  const ftBadge = fraudTypeBadge[investigation.fraud_type];

  const handleGenerateEvidencePack = async () => {
    setGeneratingEvidence(true);
    try {
      const res = await fetch('/api/evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subjectType: 'investigation',
          subjectId: investigation.id,
          accountId: investigation.primary_account || investigation.account_ids[0],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.data?.id) {
        onClose();
        router.push(`/evidence/${json.data.id}`);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setGeneratingEvidence(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={investigation.title} size="xl">
      <div className="space-y-5">
        {/* Header badges */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={ftBadge.variant}>{ftBadge.label}</Badge>
          <Badge variant={severityBadge[investigation.severity]}>
            {investigation.severity.toUpperCase()}
          </Badge>
          <Badge variant={statusBadge[investigation.status]}>
            {investigation.status.toUpperCase()}
          </Badge>
          <span className="text-[10px] text-gray-500 ml-auto">
            Detected {new Date(investigation.detected_at).toLocaleString()}
          </span>
        </div>

        {/* Confidence */}
        <ConfidenceBar score={investigation.confidence_score} />

        {/* Summary */}
        <div>
          <SectionTitle>Summary</SectionTitle>
          <p className="text-sm text-gray-300 leading-relaxed">{investigation.summary}</p>
        </div>

        {/* Evidence */}
        <div>
          <SectionTitle>Evidence</SectionTitle>
          <div className="space-y-4">
            {investigation.fraud_type === 'copy_ring' && <CopyRingEvidence evidence={investigation.evidence} />}
            {investigation.fraud_type === 'shared_identity' && <SharedIdentityEvidence evidence={investigation.evidence} />}
            {investigation.fraud_type === 'coordinated_payout' && <CoordinatedPayoutEvidence evidence={investigation.evidence} />}
            {investigation.fraud_type === 'account_churning' && <AccountChurningEvidence evidence={investigation.evidence} />}
            {investigation.fraud_type === 'profit_manipulation' && <ProfitManipulationEvidence evidence={investigation.evidence} />}
          </div>
        </div>

        {/* Accounts involved */}
        <div>
          <SectionTitle>Accounts Involved ({investigation.account_ids.length})</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {investigation.account_ids.map((id) => (
              <span
                key={id}
                className="inline-block px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-[10px] font-mono text-gray-300 hover:bg-white/10 transition-colors cursor-default"
              >
                {id}
              </span>
            ))}
          </div>
        </div>

        {/* Amount at risk */}
        <div className="flex items-center justify-between bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
          <span className="text-xs text-gray-400 uppercase tracking-wider font-semibold">Amount at Risk</span>
          <span className="text-lg font-bold text-red-400">${investigation.total_amount_at_risk.toLocaleString()}</span>
        </div>

        {/* Recommended action */}
        {investigation.recommended_action && (
          <div>
            <SectionTitle>Recommended Action</SectionTitle>
            <p className="text-sm text-yellow-400/90 bg-yellow-500/10 border border-yellow-500/20 rounded-xl px-4 py-3">
              {investigation.recommended_action}
            </p>
          </div>
        )}

        {/* Resolution notes */}
        {investigation.resolution_notes && (
          <div>
            <SectionTitle>Resolution Notes</SectionTitle>
            <p className="text-sm text-gray-400 bg-white/5 rounded-xl px-4 py-3">
              {investigation.resolution_notes}
              {investigation.resolved_by && (
                <span className="block mt-1 text-[10px] text-gray-600">
                  Resolved by {investigation.resolved_by} at {investigation.resolved_at ? new Date(investigation.resolved_at).toLocaleString() : 'N/A'}
                </span>
              )}
            </p>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-white/10">
          <Button
            variant="success"
            size="sm"
            onClick={() => onUpdateStatus(investigation.id, 'confirmed')}
            disabled={investigation.status === 'confirmed'}
          >
            Confirm
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => onUpdateStatus(investigation.id, 'dismissed')}
            disabled={investigation.status === 'dismissed'}
          >
            Dismiss
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onUpdateStatus(investigation.id, 'reviewing')}
            disabled={investigation.status === 'reviewing'}
          >
            Mark Reviewing
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={generatingEvidence}
            onClick={handleGenerateEvidencePack}
          >
            <FileText className="h-3.5 w-3.5 mr-1" /> Generate Evidence Pack
          </Button>
          <div className="ml-auto">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
