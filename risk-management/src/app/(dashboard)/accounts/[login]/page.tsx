'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, User, AlertTriangle, DollarSign, Mail } from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';
import { StatCard } from '@/components/ui/stat-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Tabs } from '@/components/ui/tabs';
import { VIOLATION_LABELS } from '@/config/violations';
import { formatCurrency, formatDateTime } from '@/lib/utils/format';

export default function AccountDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [account, setAccount] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('violations');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/accounts/${params.login}`);
        if (res.ok) setAccount(await res.json());
      } catch (err) { console.error(err); }
      finally { setLoading(false); }
    })();
  }, [params.login]);

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-500">Loading...</div>;
  if (!account) return <div className="flex items-center justify-center h-64 text-gray-500">Account not found</div>;

  const tabs = [
    { id: 'violations', label: 'Violations', count: account.violations?.length },
    { id: 'deductions', label: 'Deductions', count: account.deductions?.length },
    { id: 'emails', label: 'Emails', count: account.emails?.length },
  ];

  const violationCols = [
    { key: 'detected_at', header: 'Date', render: (v: any) => formatDateTime(v.detected_at) },
    { key: 'violation_type', header: 'Type', render: (v: any) => <Badge variant="red">{VIOLATION_LABELS[v.violation_type] || v.violation_type}</Badge> },
    { key: 'deduction_amount', header: 'Deducted', render: (v: any) => <span className="text-red-400">{formatCurrency(v.deduction_amount)}</span> },
    { key: 'status', header: 'Status', render: (v: any) => <Badge variant="silver">{v.status}</Badge> },
    { key: 'actions', header: '', render: (v: any) => <Button variant="ghost" size="sm" onClick={() => router.push(`/violations/${v.id}`)}>View</Button> },
  ];

  const deductionCols = [
    { key: 'executed_at', header: 'Date', render: (d: any) => formatDateTime(d.executed_at) },
    { key: 'amount', header: 'Amount', render: (d: any) => <span className="text-red-400 font-semibold">{formatCurrency(d.amount)}</span> },
    { key: 'execution_type', header: 'Type', render: (d: any) => <Badge variant={d.execution_type === 'automatic' ? 'blue' : 'silver'}>{d.execution_type}</Badge> },
    { key: 'reason', header: 'Reason', render: (d: any) => <span className="text-gray-400 truncate max-w-xs block">{d.reason}</span> },
  ];

  const emailCols = [
    { key: 'sent_at', header: 'Date', render: (e: any) => formatDateTime(e.sent_at) },
    { key: 'subject', header: 'Subject', render: (e: any) => <span className="text-gray-200">{e.subject}</span> },
    { key: 'template_type', header: 'Type', render: (e: any) => <Badge variant="silver">{e.template_type}</Badge> },
    { key: 'status', header: 'Status', render: (e: any) => <Badge variant={e.status === 'sent' ? 'green' : 'red'}>{e.status}</Badge> },
  ];

  const totalDeducted = (account.deductions || []).reduce((s: number, d: any) => s + d.amount, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => router.back()}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
        <h2 className="text-lg font-semibold text-white">Account: <span className="font-mono text-red-400">{account.login}</span></h2>
      </div>
      <GlassCard padding="md">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div><span className="text-gray-500">Trader</span><p className="text-white font-medium">{account.trader_name}</p></div>
          <div><span className="text-gray-500">Email</span><p className="text-gray-300">{account.email}</p></div>
          <div><span className="text-gray-500">Size</span><p className="text-white">${account.account_size?.toLocaleString()}</p></div>
          <div><span className="text-gray-500">Challenge</span><p className="text-white capitalize">{account.challenge_type}</p></div>
          <div><span className="text-gray-500">Phase</span><p className="text-white capitalize">{account.phase}</p></div>
          <div><span className="text-gray-500">Balance</span><p className="text-white">{formatCurrency(account.balance)}</p></div>
          <div><span className="text-gray-500">Equity</span><p className="text-white">{formatCurrency(account.equity)}</p></div>
          <div><span className="text-gray-500">Profile ID</span><p className="text-gray-400 font-mono text-xs">{account.user_profile_id}</p></div>
        </div>
      </GlassCard>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard title="Total Violations" value={account.violations?.length || 0} icon={AlertTriangle} />
        <StatCard title="Total Deducted" value={formatCurrency(totalDeducted)} icon={DollarSign} />
        <StatCard title="Emails Sent" value={account.emails?.length || 0} icon={Mail} />
      </div>
      <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />
      {activeTab === 'violations' && <DataTable columns={violationCols} data={account.violations || []} emptyMessage="No violations" />}
      {activeTab === 'deductions' && <DataTable columns={deductionCols} data={account.deductions || []} emptyMessage="No deductions" />}
      {activeTab === 'emails' && <DataTable columns={emailCols} data={account.emails || []} emptyMessage="No emails" />}
    </div>
  );
}
