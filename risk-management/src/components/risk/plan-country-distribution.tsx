import { BarChart3, Globe } from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';
import { formatCurrency } from '@/lib/utils/format';

interface PlanDist { plan: string; count: number; totalPayout: number }
interface CountryDist { country: string; count: number }

/** "Payouts by Plan" + "Top Countries" cards on the Overview tab. */
export function PlanCountryDistribution({ planDist, countryDist }: { planDist: PlanDist[]; countryDist: CountryDist[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Plan Distribution */}
      <GlassCard padding="sm">
        <h4 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          <BarChart3 className="h-3 w-3" /> Payouts by Plan
        </h4>
        {planDist.length > 0 ? (
          <div className="space-y-1.5">
            {planDist.map(p => (
              <div key={p.plan} className="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs">
                <span className="text-gray-300">{p.plan}</span>
                <div className="flex items-center gap-3">
                  <span className="text-gray-500">{p.count} payout{p.count !== 1 ? 's' : ''}</span>
                  <span className="text-white font-semibold">{formatCurrency(p.totalPayout)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-500">No plan data.</p>
        )}
      </GlassCard>

      {/* Country Distribution */}
      <GlassCard padding="sm">
        <h4 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          <Globe className="h-3 w-3" /> Top Countries
        </h4>
        {countryDist.length > 0 ? (
          <div className="space-y-1.5">
            {countryDist.map(c => {
              const maxCount = countryDist[0]?.count || 1;
              return (
                <div key={c.country} className="flex items-center gap-3 text-xs">
                  <span className="text-gray-300 w-[60px] shrink-0">{c.country}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                    <div className="h-full rounded-full bg-blue-500/50" style={{ width: `${(c.count / maxCount) * 100}%` }} />
                  </div>
                  <span className="text-gray-500 shrink-0">{c.count}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-gray-500">No country data.</p>
        )}
      </GlassCard>
    </div>
  );
}
