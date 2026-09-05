'use client';

import { useState } from 'react';
import { GlassCard } from '@/components/ui/glass-card';
import { Button } from '@/components/ui/button';
import { SlidersHorizontal, LineChart, CandlestickChart } from 'lucide-react';
import { useProviderContext } from '@/components/layout/provider-context';
import { LOT_LIMITS, HFT_THRESHOLDS, NEWS_WINDOW_MINUTES } from '@/config/violations';
import { FUTURES_CONFIG } from '@/config/violations';

/**
 * Per-asset-class risk-rule editor. The header Forex/Futures toggle selects
 * which rule set is shown. Values are seeded from the platform config; edits are
 * local in the demo (a prospect can see "tune your own rules"). In production
 * these persist per firm/tenant.
 */
export function RiskRulesSettings() {
  const { assetClass } = useProviderContext();
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // Editable futures thresholds (local state for the demo).
  const [dailyLoss, setDailyLoss] = useState((FUTURES_CONFIG.default_max_daily_loss_pct * 100).toFixed(1));
  const [trailingDd, setTrailingDd] = useState((FUTURES_CONFIG.default_max_trailing_drawdown_pct * 100).toFixed(1));
  const [eodHour, setEodHour] = useState(String(FUTURES_CONFIG.eod_flat_hour_utc));

  // Editable forex thresholds (local state for the demo).
  const [newsWindow, setNewsWindow] = useState(String(NEWS_WINDOW_MINUTES));

  const save = () => {
    setSavedMsg('Rules saved (demo — not persisted to a live backend).');
    setTimeout(() => setSavedMsg(null), 3000);
  };

  const Field = ({ label, value, onChange, suffix }: { label: string; value: string; onChange: (v: string) => void; suffix?: string }) => (
    <div>
      <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</label>
      <div className="flex items-center gap-1.5">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-24 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-red-500/50"
        />
        {suffix && <span className="text-xs text-gray-500">{suffix}</span>}
      </div>
    </div>
  );

  return (
    <GlassCard>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-xl bg-white/5">
          <SlidersHorizontal className="h-5 w-5 text-gray-400" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-white">Risk Rules</h2>
          <p className="text-[11px] text-gray-500 flex items-center gap-1.5">
            {assetClass === 'futures' ? <CandlestickChart className="h-3 w-3 text-amber-400" /> : <LineChart className="h-3 w-3 text-sky-400" />}
            Editing {assetClass === 'futures' ? 'Futures' : 'Forex'} rules — switch asset class in the header.
          </p>
        </div>
      </div>

      {assetClass === 'futures' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field label="Max Daily Loss" value={dailyLoss} onChange={setDailyLoss} suffix="%" />
            <Field label="Max Trailing Drawdown" value={trailingDd} onChange={setTrailingDd} suffix="%" />
            <Field label="EOD Flat (UTC hour)" value={eodHour} onChange={setEodHour} suffix="h" />
          </div>
          <div>
            <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Position Limits (contracts by account size)</h4>
            <div className="flex flex-wrap gap-2">
              {Object.entries(FUTURES_CONFIG.position_limits_by_size).map(([size, limit]) => (
                <span key={size} className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-gray-300">
                  ${Number(size).toLocaleString()} → {limit}
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field label="News Window" value={newsWindow} onChange={setNewsWindow} suffix="min" />
            <div>
              <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">HFT Thresholds</label>
              <span className="text-xs text-gray-300">{HFT_THRESHOLDS.length} time windows</span>
            </div>
          </div>
          <div>
            <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Lot Limits (forex, by account size)</h4>
            <div className="flex flex-wrap gap-2">
              {Object.entries(LOT_LIMITS).map(([size, limits]) => (
                <span key={size} className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-gray-300">
                  ${Number(size).toLocaleString()} → {limits.forex} lots
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" size="sm" onClick={save}>Save Rules</Button>
        {savedMsg && <span className="text-xs text-green-400">{savedMsg}</span>}
      </div>
    </GlassCard>
  );
}
