'use client';

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Line, ComposedChart } from 'recharts';
import { GlassCard } from '@/components/ui/glass-card';

interface DataPoint {
  date: string;
  count: number;
  total_amount: number;
}

interface DeductionsChartProps {
  data: DataPoint[];
  loading?: boolean;
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#1a1a1a] border border-white/10 rounded-xl px-4 py-3 shadow-2xl">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      {payload.map((entry: any, idx: number) => (
        <p key={idx} className="text-sm font-medium" style={{ color: entry.color }}>
          {entry.name}: {entry.name === 'Amount' ? `$${entry.value.toLocaleString()}` : entry.value}
        </p>
      ))}
    </div>
  );
}

export function DeductionsChart({ data, loading }: DeductionsChartProps) {
  if (loading) {
    return (
      <GlassCard padding="md" className="h-[350px] flex items-center justify-center">
        <div className="text-gray-500 animate-pulse">Loading chart...</div>
      </GlassCard>
    );
  }

  return (
    <GlassCard padding="md">
      <h3 className="text-sm font-semibold text-white mb-4">Deductions Over Time</h3>
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="date" tick={{ fill: '#9ca3af', fontSize: 11 }} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} />
          <YAxis yAxisId="amount" tick={{ fill: '#9ca3af', fontSize: 11 }} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} tickFormatter={(v) => `$${v.toLocaleString()}`} />
          <YAxis yAxisId="count" orientation="right" tick={{ fill: '#9ca3af', fontSize: 11 }} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} />
          <Tooltip content={<CustomTooltip />} />
          <Bar yAxisId="amount" dataKey="total_amount" name="Amount" fill="#dc2626" fillOpacity={0.6} radius={[4, 4, 0, 0]} />
          <Line yAxisId="count" type="monotone" dataKey="count" name="Count" stroke="#c0c0c0" strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </GlassCard>
  );
}
