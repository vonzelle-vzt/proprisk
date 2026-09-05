import { Shield } from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';
import { SEVERITY_COLORS } from './constants';

function SeverityBar({ distribution }: { distribution: { critical: number; high: number; medium: number; low: number } }) {
  const total = distribution.critical + distribution.high + distribution.medium + distribution.low;
  if (total === 0) return <div className="text-xs text-gray-500">No violations</div>;

  const segments = [
    { key: 'critical', count: distribution.critical, color: 'bg-red-500' },
    { key: 'high', count: distribution.high, color: 'bg-orange-500' },
    { key: 'medium', count: distribution.medium, color: 'bg-yellow-500' },
    { key: 'low', count: distribution.low, color: 'bg-blue-500' },
  ].filter(s => s.count > 0);

  return (
    <div className="space-y-1.5">
      <div className="flex h-3 rounded-full overflow-hidden bg-white/5">
        {segments.map(s => (
          <div key={s.key} className={`${s.color} transition-all`} style={{ width: `${(s.count / total) * 100}%` }} />
        ))}
      </div>
      <div className="flex gap-3 text-[10px]">
        {segments.map(s => (
          <span key={s.key} className="flex items-center gap-1">
            <span className={`inline-block h-2 w-2 rounded-full ${s.color}`} />
            <span className="text-gray-400 capitalize">{s.key}: {s.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** "Risk Severity Distribution" card on the Overview tab. */
export function SeverityDistributionCard({ distribution }: { distribution: { critical: number; high: number; medium: number; low: number } }) {
  return (
    <GlassCard padding="sm">
      <h4 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
        <Shield className="h-3 w-3" /> Risk Severity Distribution
      </h4>
      <SeverityBar distribution={distribution} />
      <div className="mt-3 grid grid-cols-2 gap-2">
        {(['critical', 'high', 'medium', 'low'] as const).map(sev => (
          <div key={sev} className={`flex items-center justify-between rounded-lg border px-3 py-2 ${SEVERITY_COLORS[sev]}`}>
            <span className="text-xs capitalize">{sev}</span>
            <span className="text-xs font-bold">{distribution[sev]}</span>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}
