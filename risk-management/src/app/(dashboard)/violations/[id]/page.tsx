'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Send, DollarSign, Mail, Clock, FileText } from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Tabs } from '@/components/ui/tabs';
import { Modal } from '@/components/ui/modal';
import { ReportDownloadButtons } from '@/components/violations/report-download-buttons';
import { VIOLATION_LABELS } from '@/config/violations';
import { formatCurrency, formatDateTime } from '@/lib/utils/format';

export default function ViolationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [violation, setViolation] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('summary');
  const [deductionModal, setDeductionModal] = useState(false);
  const [emailModal, setEmailModal] = useState(false);
  const [deductionAmount, setDeductionAmount] = useState('');
  const [deductionReason, setDeductionReason] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [generatingEvidence, setGeneratingEvidence] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/violations/${params.id}`);
        if (res.ok) setViolation(await res.json());
      } catch (err) { console.error(err); }
      finally { setLoading(false); }
    })();
  }, [params.id]);

  const handleDeduction = async () => {
    if (!violation || !deductionAmount) return;
    await fetch('/api/deductions/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: violation.account_id, amount: deductionAmount, reason: deductionReason, violation_id: violation.id }),
    });
    setDeductionModal(false);
    setDeductionAmount('');
    setDeductionReason('');
    const res = await fetch(`/api/violations/${params.id}`);
    if (res.ok) setViolation(await res.json());
  };

  const handleEmail = async () => {
    if (!violation || !emailSubject || !emailBody) return;
    await fetch('/api/emails/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: violation.account_id, recipient: violation.accounts?.email, subject: emailSubject, body: emailBody, violation_id: violation.id }),
    });
    setEmailModal(false);
    setEmailSubject('');
    setEmailBody('');
    const res = await fetch(`/api/violations/${params.id}`);
    if (res.ok) setViolation(await res.json());
  };

  const handleGenerateEvidencePack = async () => {
    if (!violation) return;
    setGeneratingEvidence(true);
    try {
      const res = await fetch('/api/evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subjectType: 'violation',
          subjectId: String(params.id),
          accountId: violation.account_id || violation.accounts?.id || violation.accountId,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.data?.id) router.push(`/evidence/${json.data.id}`);
    } catch (err) {
      console.error(err);
    } finally {
      setGeneratingEvidence(false);
    }
  };

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-500">Loading...</div>;
  if (!violation) return <div className="flex items-center justify-center h-64 text-gray-500">Violation not found</div>;

  const account = violation.accounts;
  const tabs = [{ id: 'summary', label: 'Account Summary' }, { id: 'trades', label: 'Violation Trade Details' }];

  const tradeColumns = [
    { key: 'trade_id_external', header: 'Trade ID', render: (t: any) => <span className="font-mono text-xs">{t.trade_id_external}</span> },
    { key: 'symbol', header: 'Symbol', render: (t: any) => <span className="font-semibold text-white">{t.symbol}</span> },
    { key: 'lot_size', header: 'Lots', render: (t: any) => t.lot_size?.toFixed(2) },
    { key: 'direction', header: 'Side', render: (t: any) => <Badge variant={t.direction === 'buy' ? 'green' : 'red'}>{t.direction}</Badge> },
    { key: 'open_time', header: 'Open', render: (t: any) => formatDateTime(t.open_time) },
    { key: 'close_time', header: 'Close', render: (t: any) => t.close_time ? formatDateTime(t.close_time) : '—' },
    { key: 'profit', header: 'Profit', render: (t: any) => <span className={t.profit >= 0 ? 'text-emerald-400' : 'text-red-400'}>{formatCurrency(t.profit)}</span> },
  ];
  const networkEvidence = violation.network_evidence;
  const isNetworkViolation = violation.violation_type === 'grid' || violation.violation_type === 'copy';
  const matchedPairColumns = [
    { key: 'symbol', header: 'Symbol', render: (row: any) => <span className="font-semibold text-white">{row.symbol || '—'}</span> },
    {
      key: 'a_login',
      header: 'Account A Trade',
      render: (row: any) =>
        row.account_a_trade ? (
          <span className="text-xs text-gray-300">
            {row.account_a_trade.trade_id_external} • {row.account_a_trade.direction} • {row.account_a_trade.lot_size}
          </span>
        ) : '—',
    },
    {
      key: 'b_login',
      header: 'Account B Trade',
      render: (row: any) =>
        row.account_b_trade ? (
          <span className="text-xs text-gray-300">
            {row.account_b_trade.trade_id_external} • {row.account_b_trade.direction} • {row.account_b_trade.lot_size}
          </span>
        ) : '—',
    },
    { key: 'lag_seconds', header: 'Lag / Diff (s)', render: (row: any) => (row.lag_seconds ?? '—') },
    {
      key: 'lot_diff_pct',
      header: 'Lot Diff %',
      render: (row: any) => (typeof row.lot_diff_pct === 'number' ? `${(row.lot_diff_pct * 100).toFixed(2)}%` : '—'),
    },
  ];

  const journal = [
    ...(violation.deductions || []).map((d: any) => ({ type: 'deduction', time: d.executed_at, amount: d.amount, by: d.executed_by, reason: d.reason })),
    ...(violation.emails || []).map((e: any) => ({ type: 'email', time: e.sent_at, subject: e.subject, to: e.recipient, by: e.sent_by })),
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => router.push('/violations')}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
        <h2 className="text-lg font-semibold text-white">{VIOLATION_LABELS[violation.violation_type] || violation.violation_type} Violation</h2>
        <Badge variant="red">{violation.status}</Badge>
        <div className="ml-auto flex items-center gap-2">
          <ReportDownloadButtons violationId={String(params.id)} accountId={violation.account_id} />
          <Button
            variant="secondary"
            size="sm"
            loading={generatingEvidence}
            onClick={handleGenerateEvidencePack}
          >
            <FileText className="h-3.5 w-3.5 mr-1" /> Generate Evidence Pack
          </Button>
        </div>
      </div>

      <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === 'summary' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <GlassCard padding="md">
              <h3 className="text-sm font-semibold text-white mb-4">Account Information</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                <div><span className="text-gray-500">Login</span><p className="font-mono text-red-400">{account?.login}</p></div>
                <div><span className="text-gray-500">Trader</span><p className="text-white">{account?.trader_name}</p></div>
                <div><span className="text-gray-500">Email</span><p className="text-gray-300">{account?.email}</p></div>
                <div><span className="text-gray-500">Size</span><p className="text-white">${account?.account_size?.toLocaleString()}</p></div>
                <div><span className="text-gray-500">Challenge</span><p className="text-white capitalize">{account?.challenge_type}</p></div>
                <div><span className="text-gray-500">Phase</span><p className="text-white capitalize">{account?.phase}</p></div>
                <div><span className="text-gray-500">Balance</span><p className="text-white">{formatCurrency(account?.balance || 0)}</p></div>
                <div><span className="text-gray-500">Equity</span><p className="text-white">{formatCurrency(account?.equity || 0)}</p></div>
                <div><span className="text-gray-500">Deduction Amount</span><p className="text-red-400 font-semibold">{formatCurrency(violation.deduction_amount)}</p></div>
              </div>
            </GlassCard>
            <GlassCard padding="md">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-white">Actions & Communications</h3>
                <div className="flex gap-2">
                  <Button variant="danger" size="sm" onClick={() => setDeductionModal(true)}><DollarSign className="h-3.5 w-3.5 mr-1" /> Manual Deduction</Button>
                  <Button variant="secondary" size="sm" onClick={() => setEmailModal(true)}><Mail className="h-3.5 w-3.5 mr-1" /> Send Email</Button>
                </div>
              </div>
              <div className="space-y-3">
                {journal.length === 0 && <p className="text-sm text-gray-500">No actions recorded yet.</p>}
                {journal.map((entry: any, idx: number) => (
                  <div key={idx} className="flex items-start gap-3 p-3 bg-white/[0.02] rounded-xl border border-white/5">
                    <div className="mt-0.5">{entry.type === 'deduction' ? <DollarSign className="h-4 w-4 text-red-400" /> : <Mail className="h-4 w-4 text-blue-400" />}</div>
                    <div className="flex-1 min-w-0">
                      {entry.type === 'deduction' ? (
                        <><p className="text-sm text-white">Deduction: <span className="text-red-400 font-semibold">{formatCurrency(entry.amount)}</span></p><p className="text-xs text-gray-500">{entry.reason} &bull; by {entry.by}</p></>
                      ) : (
                        <><p className="text-sm text-white">{entry.subject}</p><p className="text-xs text-gray-500">To: {entry.to} &bull; by {entry.by}</p></>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-xs text-gray-500 shrink-0"><Clock className="h-3 w-3" />{formatDateTime(entry.time)}</div>
                  </div>
                ))}
              </div>
            </GlassCard>
          </div>
          <div>
            <GlassCard padding="md">
              <h3 className="text-sm font-semibold text-white mb-4">Violation Details</h3>
              <pre className="text-xs text-gray-400 whitespace-pre-wrap overflow-auto max-h-96">{JSON.stringify(violation.details_json, null, 2)}</pre>
            </GlassCard>
          </div>
        </div>
      )}

      {activeTab === 'trades' && (
        <div className="space-y-6">
          {isNetworkViolation && networkEvidence ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <GlassCard padding="md">
                  <h3 className="text-sm font-semibold text-white mb-3">Account A</h3>
                  <p className="text-xs text-gray-400">
                    {networkEvidence.account_a?.login || '—'} • {networkEvidence.account_a?.trader_name || 'Unknown'}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">Profile: {networkEvidence.account_a?.user_profile_id || '—'}</p>
                  <p className="text-xs text-gray-300 mt-3">
                    Related trades: {networkEvidence.account_a_trades?.length || 0}
                  </p>
                </GlassCard>
                <GlassCard padding="md">
                  <h3 className="text-sm font-semibold text-white mb-3">Account B</h3>
                  <p className="text-xs text-gray-400">
                    {networkEvidence.account_b?.login || '—'} • {networkEvidence.account_b?.trader_name || 'Unknown'}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">Profile: {networkEvidence.account_b?.user_profile_id || '—'}</p>
                  <p className="text-xs text-gray-300 mt-3">
                    Related trades: {networkEvidence.account_b_trades?.length || 0}
                  </p>
                </GlassCard>
              </div>
              <GlassCard padding="none">
                <div className="px-5 py-4 border-b border-white/10">
                  <h3 className="text-sm font-semibold text-white">Matched Trade Pairs (Network Evidence)</h3>
                </div>
                <DataTable columns={matchedPairColumns} data={networkEvidence.matched_pairs || []} emptyMessage="No matched pairs found" />
              </GlassCard>
            </>
          ) : null}
          <GlassCard padding="none">
            <div className="px-5 py-4 border-b border-white/10"><h3 className="text-sm font-semibold text-white">Trades Contributing to Violation</h3></div>
            <DataTable columns={tradeColumns} data={violation.trades || []} emptyMessage="No trade data available" />
          </GlassCard>
        </div>
      )}

      <Modal isOpen={deductionModal} onClose={() => setDeductionModal(false)} title="Manual Deduction">
        <div className="space-y-4">
          <div><label className="block text-xs font-medium text-gray-400 mb-1">Amount ($)</label><input type="number" step="0.01" value={deductionAmount} onChange={(e) => setDeductionAmount(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-gray-200 outline-none focus:border-red-500/50" /></div>
          <div><label className="block text-xs font-medium text-gray-400 mb-1">Reason</label><textarea value={deductionReason} onChange={(e) => setDeductionReason(e.target.value)} rows={3} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-gray-200 outline-none focus:border-red-500/50 resize-none" /></div>
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setDeductionModal(false)}>Cancel</Button><Button variant="primary" onClick={handleDeduction}>Execute Deduction</Button></div>
        </div>
      </Modal>

      <Modal isOpen={emailModal} onClose={() => setEmailModal(false)} title="Send Manual Email">
        <div className="space-y-4">
          <div><label className="block text-xs font-medium text-gray-400 mb-1">Subject</label><input type="text" value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-gray-200 outline-none focus:border-red-500/50" /></div>
          <div><label className="block text-xs font-medium text-gray-400 mb-1">Body</label><textarea value={emailBody} onChange={(e) => setEmailBody(e.target.value)} rows={6} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-gray-200 outline-none focus:border-red-500/50 resize-none" /></div>
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setEmailModal(false)}>Cancel</Button><Button variant="primary" onClick={handleEmail}><Send className="h-3.5 w-3.5 mr-1" /> Send</Button></div>
        </div>
      </Modal>
    </div>
  );
}
