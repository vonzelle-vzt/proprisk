'use client';

import { GlassCard } from '@/components/ui/glass-card';
import { Badge } from '@/components/ui/badge';
import { VIOLATION_LABELS } from '@/config/violations';
import { formatCurrency } from '@/lib/utils/format';

interface BreakdownItem {
  label: string;
  count: number;
  total_amount: number;
}

interface BreakdownCardProps {
  title: string;
  items: BreakdownItem[];
  loading?: boolean;
}

const BAR_COLORS = [
  'bg-red-500',
  'bg-orange-500',
  'bg-yellow-500',
  'bg-blue-500',
  'bg-purple-500',
  'bg-emerald-500',
  'bg-pink-500',
  'bg-cyan-500',
];

export function BreakdownCard({ title, items, loading }: BreakdownCardProps) {
  if (loading) {
    return (
      <GlassCard padding="sm" className="animate-pulse">
        <div className="h-4 w-32 bg-white/10 rounded mb-4" />
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-8 bg-white/5 rounded" />)}
        </div>
      </GlassCard>
    );
  }

  if (items.length === 0) {
    return (
      <GlassCard padding="sm">
        <h3 className="text-xs font-semibold text-white mb-3">{title}</h3>
        <p className="text-xs text-gray-500">No data available.</p>
      </GlassCard>
    );
  }

  const maxAmount = Math.max(...items.map((i) => i.total_amount), 1);
  const totalAmount = items.reduce((s, i) => s + i.total_amount, 0);
  const totalCount = items.reduce((s, i) => s + i.count, 0);

  return (
    <GlassCard padding="sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-white">{title}</h3>
        <span className="text-[10px] text-gray-500">{totalCount} total &bull; {formatCurrency(totalAmount)}</span>
      </div>

      {/* Stacked proportion bar */}
      <div className="flex h-2 rounded-full overflow-hidden bg-white/5 mb-3">
        {items.map((item, i) => (
          <div
            key={item.label}
            className={`${BAR_COLORS[i % BAR_COLORS.length]} transition-all`}
            style={{ width: `${(item.total_amount / totalAmount) * 100}%` }}
            title={`${item.label}: ${formatCurrency(item.total_amount)}`}
          />
        ))}
      </div>

      {/* Item rows */}
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <div key={item.label} className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full shrink-0 ${BAR_COLORS[i % BAR_COLORS.length]}`} />
            <span className="text-[11px] text-gray-300 flex-1 truncate">{item.label}</span>
            <span className="text-[10px] text-gray-500 shrink-0">{item.count} acct{item.count !== 1 ? 's' : ''}</span>
            <span className="text-[11px] text-red-400 font-semibold shrink-0">{formatCurrency(item.total_amount)}</span>
            <span className="text-[9px] text-gray-600 shrink-0 w-[32px] text-right">{((item.total_amount / totalAmount) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}

export function ViolationTypeBreakdown({ data, loading }: { data: { type: string; count: number; total_amount: number }[]; loading?: boolean }) {
  const items = data.map((d) => ({ label: VIOLATION_LABELS[d.type] || d.type, count: d.count, total_amount: d.total_amount }));
  return <BreakdownCard title="Deductions by Violation Type" items={items} loading={loading} />;
}

export function AccountSizeBreakdown({ data, loading }: { data: { size: number; count: number; total_amount: number }[]; loading?: boolean }) {
  const items = data.map((d) => ({ label: `$${d.size.toLocaleString()}`, count: d.count, total_amount: d.total_amount }));
  return <BreakdownCard title="By Account Size" items={items} loading={loading} />;
}

export function ChallengeTypeBreakdown({ data, loading }: { data: { type: string; count: number; total_amount: number }[]; loading?: boolean }) {
  const labels: Record<string, string> = { pro: 'Pro', flex: 'Flex', '1_phase': '1-Phase' };
  const items = data.map((d) => ({ label: labels[d.type] || d.type, count: d.count, total_amount: d.total_amount }));
  return <BreakdownCard title="By Challenge Type" items={items} loading={loading} />;
}
