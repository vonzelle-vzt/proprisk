import { formatCurrency } from '@/lib/utils/format';

const VIOLATION_CHART_COLORS: Record<string, { ring: string; dot: string; text: string }> = {
  overleveraging: { ring: '#eab308', dot: 'bg-yellow-500', text: 'text-yellow-400' },
  hft: { ring: '#3b82f6', dot: 'bg-blue-500', text: 'text-blue-400' },
  martingale: { ring: '#a855f7', dot: 'bg-purple-500', text: 'text-purple-400' },
  news: { ring: '#22c55e', dot: 'bg-green-500', text: 'text-green-400' },
  grid: { ring: '#94a3b8', dot: 'bg-slate-400', text: 'text-slate-400' },
  copy: { ring: '#f97316', dot: 'bg-orange-500', text: 'text-orange-400' },
  violations: { ring: '#f43f5e', dot: 'bg-rose-500', text: 'text-rose-400' },
  overnight: { ring: '#f59e0b', dot: 'bg-amber-500', text: 'text-amber-400' },
};

const DEFAULT_CHART_COLOR = { ring: '#6b7280', dot: 'bg-gray-500', text: 'text-gray-400' };

export function ViolationDonutChart({ data }: { data: { type: string; label: string; count: number; amount: number }[] }) {
  const totalAmount = data.reduce((s, d) => s + d.amount, 0);
  const totalAccounts = data.reduce((s, d) => s + d.count, 0);

  if (data.length === 0 || totalAmount === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-gray-500">
        No violation data available.
      </div>
    );
  }

  // Build conic gradient segments
  let cumulativePct = 0;
  const segments = data.map((d) => {
    const pct = (d.amount / totalAmount) * 100;
    const start = cumulativePct;
    cumulativePct += pct;
    const color = VIOLATION_CHART_COLORS[d.type]?.ring || DEFAULT_CHART_COLOR.ring;
    return { ...d, pct, start, color };
  });

  const conicGradient = segments
    .map((s) => `${s.color} ${s.start.toFixed(2)}% ${(s.start + s.pct).toFixed(2)}%`)
    .join(', ');

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-5 flex-1 min-h-0">
        {/* Donut */}
        <div className="relative shrink-0">
          <div
            className="h-[130px] w-[130px] rounded-full"
            style={{
              background: `conic-gradient(${conicGradient})`,
            }}
          >
            <div className="absolute inset-[22px] rounded-full bg-[#0d0d12] flex flex-col items-center justify-center">
              <span className="text-sm font-bold text-white">{formatCurrency(totalAmount)}</span>
              <span className="text-[9px] text-gray-500 uppercase tracking-wider">Total</span>
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="flex-1 space-y-1.5 min-w-0 overflow-y-auto max-h-[160px]">
          {segments.map((s) => {
            const colors = VIOLATION_CHART_COLORS[s.type] || DEFAULT_CHART_COLOR;
            return (
              <div key={s.type} className="flex items-center gap-2 group">
                <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${colors.dot}`} />
                <span className="text-[11px] text-gray-300 truncate flex-1">{s.label}</span>
                <span className="text-[10px] text-gray-500 shrink-0">{s.count} acct{s.count !== 1 ? 's' : ''}</span>
                <span className={`text-[11px] font-semibold shrink-0 ${colors.text}`}>{formatCurrency(s.amount)}</span>
                <span className="text-[9px] text-gray-600 shrink-0 w-[28px] text-right">{s.pct.toFixed(0)}%</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom summary */}
      <div className="mt-3 pt-2.5 border-t border-white/5 flex items-center justify-between text-[10px] text-gray-500">
        <span>{data.length} violation type{data.length !== 1 ? 's' : ''} detected</span>
        <span>{totalAccounts} account{totalAccounts !== 1 ? 's' : ''} affected</span>
      </div>
    </div>
  );
}
