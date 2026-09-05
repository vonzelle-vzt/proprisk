'use client';

import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { GlassCard } from '@/components/ui/glass-card';
import { formatCurrency, formatDate } from '@/lib/utils/format';
import { Shield, User, DollarSign, BarChart3, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { PayoutHistoryRecord } from '@/types/history';

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[11px] text-gray-500 shrink-0">{label}</span>
      <span className="text-xs text-gray-200 truncate">{children}</span>
    </div>
  );
}

interface Props {
  record: PayoutHistoryRecord | null;
  isOpen: boolean;
  onClose: () => void;
}

export function HistoryDetailModal({ record, isOpen, onClose }: Props) {
  if (!record) return null;

  const snap = record.fullSnapshot;
  const decisionIcon = record.decision === 'approved'
    ? <CheckCircle2 className="h-4 w-4 text-green-400" />
    : <XCircle className="h-4 w-4 text-red-400" />;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Payout History — ${record.login || record.platformAccountId}`} size="xl">
      <div className="space-y-3">
        {/* Decision Banner */}
        <GlassCard padding="sm" className={record.decision === 'approved' ? 'border-green-500/20' : 'border-red-500/20'}>
          <div className="flex items-center gap-3">
            {decisionIcon}
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-white capitalize">{record.decision}</span>
                <Badge variant={record.decision === 'approved' ? 'green' : 'red'}>
                  {record.decision === 'approved' ? 'Paid' : 'Not Paid'}
                </Badge>
              </div>
              <div className="flex items-center gap-3 mt-1 text-[11px] text-gray-400">
                <span>By: {record.decidedBy}</span>
                <span>{record.decidedAt ? formatDate(record.decidedAt) : '—'}</span>
              </div>
            </div>
            <span className="text-lg font-bold text-white">{formatCurrency(record.clientAmount || record.amount || 0)}</span>
          </div>
          {record.decisionNotes && (
            <p className="mt-2 text-xs text-gray-400 border-t border-white/10 pt-2">{record.decisionNotes}</p>
          )}
        </GlassCard>

        {/* Account + KYC */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <GlassCard padding="sm">
            <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              <Shield className="h-3 w-3" /> Account
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <InfoRow label="Login:"><span className="font-mono text-white">{record.login || '—'}</span></InfoRow>
              <InfoRow label="Account:"><span className="font-mono">{record.platformAccountId}</span></InfoRow>
              <InfoRow label="Email:">{record.email || '—'}</InfoRow>
              <InfoRow label="Name:">{record.firstName && record.lastName ? `${record.firstName} ${record.lastName}` : '—'}</InfoRow>
              <InfoRow label="Country:">{record.country || '—'}</InfoRow>
              <InfoRow label="Plan:"><span className="truncate max-w-[140px] block">{record.plan || '—'}</span></InfoRow>
              <InfoRow label="Date Req:">{record.dateRequested ? formatDate(record.dateRequested) : '—'}</InfoRow>
              <InfoRow label="Order:"><span className="font-mono">{record.platformOrderId || '—'}</span></InfoRow>
            </div>
          </GlassCard>

          <GlassCard padding="sm">
            <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              <User className="h-3 w-3" /> KYC & User
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <InfoRow label="KYC:">
                <Badge variant={record.kycStatus === 'Verified' || record.kycStatus === 'COMPLETED' ? 'green' : 'yellow'}>
                  {record.kycStatus === 'COMPLETED' ? 'Verified' : record.kycStatus || '—'}
                </Badge>
              </InfoRow>
              <InfoRow label="Verified:">
                <span className={record.kycVerified ? 'text-green-400' : 'text-yellow-400'}>{record.kycVerified ? 'Yes' : 'No'}</span>
              </InfoRow>
              <InfoRow label="Blacklisted:">
                <span className={record.isBlacklisted ? 'text-red-400 font-semibold' : 'text-green-400'}>{record.isBlacklisted ? 'YES' : 'No'}</span>
              </InfoRow>
              <InfoRow label="Pre-Approval:">
                <Badge variant={record.preApprovedStatus === 1 ? 'green' : record.preApprovedStatus === -1 ? 'red' : 'yellow'}>
                  {record.preApprovedStatus === 1 ? 'Pre-Approved' : record.preApprovedStatus === -1 ? 'Not Pre-Approved' : 'Not Reviewed'}
                </Badge>
              </InfoRow>
            </div>
          </GlassCard>
        </div>

        {/* Payout Details + Account Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <GlassCard padding="sm">
            <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              <DollarSign className="h-3 w-3" /> Payout Details
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <InfoRow label="Amount:"><span className="font-semibold text-white">{formatCurrency(record.amount || 0)}</span></InfoRow>
              <InfoRow label="Client:"><span className="font-semibold text-green-400">{formatCurrency(record.clientAmount || 0)}</span></InfoRow>
              <InfoRow label="Fee:">{formatCurrency(record.fee || 0)}</InfoRow>
              <InfoRow label="Profit Share:">{record.profitSharePct ? `${record.profitSharePct}%` : '—'}</InfoRow>
              <InfoRow label="Method:"><span className="uppercase">{snap?.method || record.method || '—'}</span></InfoRow>
              <InfoRow label="Balance:">{record.balance ? formatCurrency(record.balance) : '—'}</InfoRow>
            </div>
          </GlassCard>

          <GlassCard padding="sm">
            <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              <BarChart3 className="h-3 w-3" /> Account Metrics
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <InfoRow label="Starting Bal:">{record.startingBalance ? formatCurrency(record.startingBalance) : '—'}</InfoRow>
              <InfoRow label="Traded Days:">{record.tradedDays ?? '—'}</InfoRow>
              <InfoRow label="Total P&L:">
                <span className={(record.totalPnl || 0) >= 0 ? 'text-green-400' : 'text-red-400'}>
                  {record.totalPnl != null ? formatCurrency(record.totalPnl) : '—'}
                </span>
              </InfoRow>
              <InfoRow label="Approved Payouts:">{snap?.numApprovedPayouts ?? '—'}</InfoRow>
            </div>
            <div className="mt-2 flex gap-1.5">
              {snap?.banNewsTrading && <Badge variant="yellow" className="!text-[10px]">News Trading Restricted</Badge>}
              {snap?.banHFT && <Badge variant="yellow" className="!text-[10px]">HFT Restricted</Badge>}
              {snap?.banMTGL && <Badge variant="yellow" className="!text-[10px]">Martingale Restricted</Badge>}
            </div>
          </GlassCard>
        </div>

        {/* Violations & Deductions */}
        <GlassCard padding="sm">
          <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            <AlertTriangle className="h-3 w-3" /> Violations & Deductions
          </h4>
          {record.deductionsTotal > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3 text-xs">
                <span className="text-gray-500">Total:</span>
                <span className="text-red-400 font-semibold">{formatCurrency(record.deductionsTotal)}</span>
                <span className="text-gray-500">({record.deductionsViolationCount} violation{record.deductionsViolationCount !== 1 ? 's' : ''})</span>
              </div>
              {record.deductionsByType && Object.keys(record.deductionsByType).length > 0 && (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
                  {Object.entries(record.deductionsByType).filter(([type]) => type !== 'profit_cap' && type !== '2_percent_cap').map(([type, amount]) => (
                    <div key={type} className="flex items-center justify-between rounded-lg border border-white/10 bg-black/30 px-2.5 py-1 text-[11px]">
                      <Badge variant="red" className="!text-[10px] !px-1.5 !py-0">{type}</Badge>
                      <span className="text-red-400 font-semibold">{formatCurrency(amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-gray-500">No deductions at decision time</p>
          )}
          {record.violationsList.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {record.violationsList.map((v) => <Badge key={v} variant="red" className="!text-[10px]">{v}</Badge>)}
            </div>
          )}
        </GlassCard>
      </div>
    </Modal>
  );
}
