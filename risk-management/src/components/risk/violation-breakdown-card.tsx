import { AlertTriangle } from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';
import { ViolationDonutChart } from './violation-donut-chart';

/**
 * "Violation Type Breakdown" card — identical markup used on both the
 * funded-payouts Overview tab and the Challenges segment.
 */
export function ViolationBreakdownCard({ data }: { data: { type: string; label: string; count: number; amount: number }[] }) {
  return (
    <GlassCard padding="sm">
      <h4 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
        <AlertTriangle className="h-3 w-3" /> Violation Type Breakdown
      </h4>
      <ViolationDonutChart data={data} />
    </GlassCard>
  );
}
