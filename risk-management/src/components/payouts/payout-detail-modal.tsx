'use client';

import { useState, useCallback } from 'react';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { GlassCard } from '@/components/ui/glass-card';
import { formatCurrency, formatDate } from '@/lib/utils/format';
import { Shield, Globe, AlertTriangle, Search, Loader2, User, DollarSign, BarChart3, CheckCircle2, XCircle, Clock, Copy, Check } from 'lucide-react';
import type { PayoutRecord, PayoutStatus, IPCheckResult } from '@/types/payouts';

function CopyableField({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);

  return (
    <button onClick={handleCopy} className={`inline-flex items-center gap-1 hover:text-red-400 transition-colors ${className || ''}`} title="Click to copy">
      {value}
      {copied ? <Check className="h-2.5 w-2.5 text-green-400" /> : <Copy className="h-2.5 w-2.5 text-gray-500" />}
    </button>
  );
}

interface PayoutDetailModalProps {
  record: PayoutRecord | null;
  isOpen: boolean;
  onClose: () => void;
  onStatusChange: (id: string, status: PayoutStatus) => void;
  onNotesChange: (id: string, notes: string) => void;
  onPreApproval?: (id: string, preApprovalStatus: number, note?: string) => void;
  onFinalAction?: (id: string, action: 'approve' | 'reject', note?: string) => void;
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[11px] text-gray-500 shrink-0">{label}</span>
      <span className="text-xs text-gray-200 truncate">{children}</span>
    </div>
  );
}

export function PayoutDetailModal({ record, isOpen, onClose, onStatusChange, onNotesChange, onPreApproval, onFinalAction }: PayoutDetailModalProps) {
  const [notes, setNotes] = useState(record?.notes || '');
  const [ipInput, setIpInput] = useState('');
  const [ipResults, setIpResults] = useState<IPCheckResult[]>([]);
  const [ipLoading, setIpLoading] = useState(false);
  const [riskLoading, setRiskLoading] = useState(false);
  const [riskResult, setRiskResult] = useState<any>(null);
  const [preApprovalLoading, setPreApprovalLoading] = useState(false);
  const [finalActionLoading, setFinalActionLoading] = useState<string | null>(null);

  if (!record) return null;

  const handleStatusChange = (status: PayoutStatus) => {
    onStatusChange(record.id, status);
  };

  const handleSaveNotes = () => {
    onNotesChange(record.id, notes);
  };

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
    } catch {
      // noop
    } finally {
      setIpLoading(false);
    }
  };

  const handleRiskCheck = async () => {
    const accountId = record.accountId || record.login;
    if (!accountId) return;
    setRiskLoading(true);
    try {
      const res = await fetch(`/api/payouts/${accountId}/risk-check`, { method: 'POST' });
      const json = await res.json();
      setRiskResult(json.data);
    } catch {
      // noop
    } finally {
      setRiskLoading(false);
    }
  };

  const statusButtons: { status: PayoutStatus; label: string; variant: 'primary' | 'success' | 'warning' | 'secondary' | 'danger' }[] = [
    { status: 'Investigate', label: 'Investigate', variant: 'warning' },
    { status: 'Cleared', label: 'Clear', variant: 'success' },
    { status: 'Rejected', label: 'Reject', variant: 'danger' },
    { status: 'Banned', label: 'Ban', variant: 'danger' },
  ];

  const handlePreApproval = async (status: number) => {
    if (!onPreApproval) return;
    setPreApprovalLoading(true);
    try {
      await onPreApproval(record.id, status, notes || undefined);
    } finally {
      setPreApprovalLoading(false);
    }
  };

  const handleFinalAction = async (action: 'approve' | 'reject') => {
    if (!onFinalAction) return;
    setFinalActionLoading(action);
    try {
      await onFinalAction(record.id, action, notes || undefined);
    } finally {
      setFinalActionLoading(null);
    }
  };

  const preApprovalLabel = record.preApprovedStatus === 1 ? 'Pre-Approved' : record.preApprovedStatus === -1 ? 'Not Pre-Approved' : 'Not Reviewed';
  const preApprovalVariant = record.preApprovedStatus === 1 ? 'green' : record.preApprovedStatus === -1 ? 'red' : 'silver';

  const deductionBreakdown = record.platformDeductions?.breakdownByType;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Payout Review — ${record.login || record.accountId}`} size="xl">
      <div className="space-y-3">
        {/* Top row: Account + KYC side by side */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <GlassCard padding="sm">
            <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              <Shield className="h-3 w-3" /> Account
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <InfoRow label="Login:">{record.login ? <CopyableField value={record.login} className="font-mono text-white" /> : <span>—</span>}</InfoRow>
              <InfoRow label="Account:">{record.accountId ? <CopyableField value={record.accountId} className="font-mono" /> : <span>—</span>}</InfoRow>
              <InfoRow label="Email:">{record.email ? <CopyableField value={record.email} /> : <span>—</span>}</InfoRow>
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
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
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
        </div>

        {/* Payout Details + Account Metrics side by side */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <GlassCard padding="sm">
            <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              <DollarSign className="h-3 w-3" /> Payout Details
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <InfoRow label="Amount:"><span className="font-semibold text-white">{formatCurrency(record.amount || 0)}</span></InfoRow>
              <InfoRow label="Client:"><span className="font-semibold text-green-400">{formatCurrency(record.clientAmount || 0)}</span></InfoRow>
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

          {(record.accountSize != null || record.startingBalance != null || record.tradedDays != null) && (
            <GlassCard padding="sm">
              <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                <BarChart3 className="h-3 w-3" /> Account Metrics
              </h4>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                {(record.startingBalance || record.accountSize) != null && (
                  <InfoRow label="Starting Bal:">{formatCurrency(record.startingBalance || record.accountSize || 0)}</InfoRow>
                )}
                {record.tradedDays != null && <InfoRow label="Traded Days:">{record.tradedDays}</InfoRow>}
                {record.maxDailyProfit != null && <InfoRow label="Max Daily P:">{formatCurrency(record.maxDailyProfit)}</InfoRow>}
                {record.maxDailyProfitPrev != null && <InfoRow label="Max Daily P (prev):">{formatCurrency(record.maxDailyProfitPrev)}</InfoRow>}
                {record.balanceAtRequest != null && <InfoRow label="Bal at Req:">{formatCurrency(record.balanceAtRequest)}</InfoRow>}
                {record.numApprovedPayouts != null && (
                  <InfoRow label="Approved:">{record.numApprovedPayouts} ({formatCurrency(record.approvedPayouts || 0)})</InfoRow>
                )}
              </div>
              <div className="mt-2 flex gap-1.5">
                {record.banNewsTrading && <Badge variant="yellow" className="!text-[10px]">News Trading Restricted</Badge>}
                {record.banHFT && <Badge variant="yellow" className="!text-[10px]">HFT Restricted</Badge>}
                {record.banMTGL && <Badge variant="yellow" className="!text-[10px]">Martingale Restricted</Badge>}
              </div>
            </GlassCard>
          )}
        </div>

        {/* Violations & Deductions - full width */}
        <GlassCard padding="sm">
          <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            <AlertTriangle className="h-3 w-3" /> Violations & Deductions
          </h4>
          {record.platformDeductions && record.platformDeductions.totalDeductions > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3 text-xs">
                <span className="text-gray-500">Total:</span>
                <span className="text-red-400 font-semibold">{formatCurrency(record.platformDeductions.totalDeductions)}</span>
                <span className="text-gray-500">({record.platformDeductions.violationCount} violation{record.platformDeductions.violationCount !== 1 ? 's' : ''})</span>
              </div>
              {deductionBreakdown && Object.keys(deductionBreakdown).length > 0 && (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
                  {Object.entries(deductionBreakdown).filter(([type]) => type !== 'profit_cap' && type !== '2_percent_cap').map(([type, amount]) => (
                    <div key={type} className="flex items-center justify-between rounded-lg border border-white/10 bg-black/30 px-2.5 py-1 text-[11px]">
                      <Badge variant="red" className="!text-[10px] !px-1.5 !py-0">{type}</Badge>
                      <span className="text-red-400 font-semibold">{formatCurrency(amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-gray-500">No deductions detected</p>
          )}
          {record.platformViolations.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {record.platformViolations.map((v) => <Badge key={v} variant="red" className="!text-[10px]">{v}</Badge>)}
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <Button variant="secondary" size="sm" onClick={handleRiskCheck} disabled={riskLoading}>
              {riskLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Search className="mr-1.5 h-3.5 w-3.5" />}
              Risk Check
            </Button>
          </div>
          <div className="mt-2">
            <h5 className="text-[10px] text-gray-500 mb-1">IP Check — enter IP address(es) separated by comma</h5>
            <div className="flex gap-2">
              <input
                type="text"
                value={ipInput}
                onChange={(e) => setIpInput(e.target.value)}
                placeholder="e.g. 192.168.1.1, 10.0.0.1"
                className="flex-1 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:border-red-500/50 focus:outline-none"
              />
              <Button variant="secondary" size="sm" onClick={handleIpCheck} disabled={ipLoading || !ipInput.trim()}>
                {ipLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Globe className="mr-1.5 h-3.5 w-3.5" />}
                Check IP
              </Button>
            </div>
          </div>
          {riskResult && (
            <p className="mt-1.5 text-[11px] text-gray-400">{riskResult.details}</p>
          )}
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

        {/* Pre-Approval Workflow (Trading Platform Sync) */}
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
            <Button
              variant="success"
              size="sm"
              onClick={() => handlePreApproval(1)}
              disabled={preApprovalLoading || record.preApprovedStatus === 1}
            >
              {preApprovalLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}
              Pre-Approve
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handlePreApproval(0)}
              disabled={preApprovalLoading || record.preApprovedStatus === 0 || record.preApprovedStatus == null}
            >
              {preApprovalLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Clock className="mr-1 h-3 w-3" />}
              Not Reviewed
            </Button>
            <Button
              variant="warning"
              size="sm"
              onClick={() => handlePreApproval(-1)}
              disabled={preApprovalLoading || record.preApprovedStatus === -1}
            >
              {preApprovalLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <XCircle className="mr-1 h-3 w-3" />}
              Not Pre-Approved
            </Button>
          </div>
          <div className="mt-3 pt-3 border-t border-white/10">
            <p className="text-[10px] text-gray-500 mb-2">Final Actions — permanently removes payout from pending list</p>
            <div className="flex gap-2">
              <Button
                variant="success"
                size="sm"
                onClick={() => handleFinalAction('approve')}
                disabled={!!finalActionLoading}
              >
                {finalActionLoading === 'approve' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}
                Approve (Paid)
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => handleFinalAction('reject')}
                disabled={!!finalActionLoading}
              >
                {finalActionLoading === 'reject' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <XCircle className="mr-1 h-3 w-3" />}
                Reject (Not Paid)
              </Button>
            </div>
          </div>
        </GlassCard>

        {/* Notes + Internal Status side by side */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <GlassCard padding="sm">
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">Notes</h4>
            <textarea
              className="w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:border-red-500/50 focus:outline-none resize-none"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add review notes..."
            />
            <Button variant="secondary" size="sm" className="mt-1.5" onClick={handleSaveNotes}>
              Save Notes
            </Button>
          </GlassCard>

          <GlassCard padding="sm">
            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">Internal Status</h4>
            <div className="flex flex-wrap gap-1.5">
              {statusButtons.map(({ status, label, variant }) => (
                <Button
                  key={status}
                  variant={variant}
                  size="sm"
                  onClick={() => handleStatusChange(status)}
                  disabled={record.status === status}
                >
                  {label}
                </Button>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-gray-500">
              Current: <Badge variant={record.status === 'Cleared' ? 'green' : record.status === 'Pending' ? 'yellow' : 'red'}>{record.status}</Badge>
            </p>
          </GlassCard>
        </div>
      </div>
    </Modal>
  );
}
