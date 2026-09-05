'use client';

import { CheckCircle2, XCircle, DollarSign, BarChart3 } from 'lucide-react';
import { StatCard } from '@/components/ui/stat-card';
import { formatCurrency } from '@/lib/utils/format';
import type { PayoutHistorySummary } from '@/types/history';

interface Props {
  summary: PayoutHistorySummary | null;
  loading?: boolean;
}

export function HistorySummaryCards({ summary, loading }: Props) {
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
        title="Total Approved"
        value={summary?.totalApproved ?? 0}
        icon={CheckCircle2}
        subtitle="Payouts paid out"
        className="border-green-500/20"
      />
      <StatCard
        title="Total Rejected"
        value={summary?.totalRejected ?? 0}
        icon={XCircle}
        subtitle="Payouts rejected"
        className="border-red-500/20"
      />
      <StatCard
        title="Total Amount Paid"
        value={formatCurrency(summary?.totalAmountPaid ?? 0)}
        icon={DollarSign}
        subtitle="Client payouts"
      />
      <StatCard
        title="Avg Payout"
        value={formatCurrency(summary?.avgPayout ?? 0)}
        icon={BarChart3}
        subtitle="Per approved payout"
      />
    </div>
  );
}
