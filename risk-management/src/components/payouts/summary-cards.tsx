'use client';

import { Activity, Globe, ShieldAlert, DollarSign } from 'lucide-react';
import { StatCard } from '@/components/ui/stat-card';
import { formatCurrency } from '@/lib/utils/format';
import type { PayoutSummary } from '@/types/payouts';

interface SummaryCardsProps {
  summary: PayoutSummary | null;
  loading?: boolean;
}

export function SummaryCards({ summary, loading }: SummaryCardsProps) {
  if (loading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl border border-white/10 bg-white/5" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Active Records"
        value={summary?.total ?? 0}
        icon={Activity}
        subtitle="Pending / Investigate"
      />
      <StatCard
        title="IP Mismatches"
        value={summary?.ipFlags ?? 0}
        icon={Globe}
        subtitle="Requires follow-up"
        className="border-yellow-500/20"
      />
      <StatCard
        title="Open Investigations"
        value={summary?.investigations ?? 0}
        icon={ShieldAlert}
        subtitle="Trading Platform or manual flags"
        className="border-red-500/20"
      />
      <StatCard
        title="Total Payouts"
        value={formatCurrency(summary?.totalClientAmount ?? 0)}
        icon={DollarSign}
        subtitle="Pending client amount"
      />
    </div>
  );
}
