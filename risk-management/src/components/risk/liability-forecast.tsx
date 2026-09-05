'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { TrendingUp, RefreshCw, AlertTriangle, RotateCcw } from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';
import { StatCard } from '@/components/ui/stat-card';
import { SegmentToggle } from '@/components/ui/segment-toggle';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils/format';
import { useAssetClass } from '@/components/layout/provider-context';
import type { LiabilityForecast } from '@/lib/forecast/types';

// Dark-surface categorical slots, validated for CVD separation + contrast
// (dataviz skill: node scripts/validate_palette.js "#3987e5,#d95926,#e66767" --mode dark → PASS).
const COLOR_PENDING = '#3987e5'; // blue — pending-payout component of p50
const COLOR_PIPELINE = '#d95926'; // orange — funded-pipeline component of p50
const COLOR_BAND = '#e66767'; // red — the p50→p90 uncertainty band
const COLOR_P50_LINE = '#e5e7eb'; // gray-200 — the p50 line itself

function formatDateShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function formatPct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

interface ChartPoint {
  date: string;
  label: string;
  pendingComponent: number;
  pipelineComponent: number;
  bandSpread: number;
  p50: number;
  p90: number;
}

function ForecastTooltip({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  const point: ChartPoint | undefined = payload[0]?.payload;
  if (!point) return null;
  return (
    <div className="rounded-lg border border-white/15 bg-[#14141a] px-3 py-2 shadow-xl text-[11px] space-y-1">
      <div className="font-semibold text-gray-200">{label}</div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-gray-500">Pending</span>
        <span style={{ color: COLOR_PENDING }} className="font-medium">{formatCurrency(point.pendingComponent)}</span>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-gray-500">Pipeline</span>
        <span style={{ color: COLOR_PIPELINE }} className="font-medium">{formatCurrency(point.pipelineComponent)}</span>
      </div>
      <div className="flex items-center justify-between gap-4 border-t border-white/10 pt-1">
        <span className="text-gray-400">P50 (expected)</span>
        <span className="text-gray-100 font-semibold">{formatCurrency(point.p50)}</span>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-gray-400">P90 (worst-case)</span>
        <span style={{ color: COLOR_BAND }} className="font-semibold">{formatCurrency(point.p90)}</span>
      </div>
    </div>
  );
}

const HORIZON_SEGMENTS = [
  { id: '7', label: '7 Days' },
  { id: '30', label: '30 Days' },
];

/**
 * Payout-liability forecast — deterministic p50/p90 projection (pending
 * queue + funded-pipeline arrivals) with scenario controls, countering
 * "generative AI payout simulation" with a concrete, explainable model.
 * See src/lib/forecast/liability.ts for the math.
 */
export function LiabilityForecastSection() {
  const assetClass = useAssetClass();
  const [horizonDays, setHorizonDays] = useState<7 | 30>(7);
  const [approvalOverride, setApprovalOverride] = useState<number | null>(null);
  const [deductionOverride, setDeductionOverride] = useState<number | null>(null);
  const [forecast, setForecast] = useState<LiabilityForecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchForecast = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sp = new URLSearchParams({ assetClass, horizonDays: String(horizonDays) });
      if (approvalOverride !== null) sp.set('approvalRate', String(approvalOverride));
      if (deductionOverride !== null) sp.set('deductionRate', String(deductionOverride));
      const res = await fetch(`/api/forecast/liability?${sp.toString()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setForecast(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load liability forecast');
    } finally {
      setLoading(false);
    }
  }, [assetClass, horizonDays, approvalOverride, deductionOverride]);

  // Clear stale data the instant the asset class changes, matching the rest
  // of the dashboard's hooks (e.g. usePlatformDashboard).
  useEffect(() => { setForecast(null); setLoading(true); }, [assetClass]);
  useEffect(() => { fetchForecast(); }, [fetchForecast]);

  const chartData: ChartPoint[] = useMemo(() => {
    if (!forecast) return [];
    return forecast.points.map((p) => ({
      date: p.date,
      label: formatDateShort(p.date),
      pendingComponent: p.pendingComponent,
      pipelineComponent: p.pipelineComponent,
      bandSpread: Math.max(0, p.p90 - p.p50),
      p50: p.p50,
      p90: p.p90,
    }));
  }, [forecast]);

  const approvalRatePct = Math.round((approvalOverride ?? forecast?.assumptions.approvalRate ?? 0.72) * 100);
  const deductionRatePct = Math.round((deductionOverride ?? forecast?.assumptions.avgDeductionRate ?? 0.18) * 100);
  const hasOverrides = approvalOverride !== null || deductionOverride !== null;

  return (
    <GlassCard padding="sm">
      <div className="flex flex-col gap-1 mb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            <TrendingUp className="h-3 w-3" /> Payout-Liability Forecast
          </h4>
          <p className="text-[10px] text-gray-600 mt-0.5">
            Deterministic p50/p90 projection — pending queue + funded pipeline, not a simulation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SegmentToggle
            segments={HORIZON_SEGMENTS}
            active={String(horizonDays)}
            onChange={(id) => setHorizonDays(id === '30' ? 30 : 7)}
          />
          <Button variant="ghost" size="sm" onClick={fetchForecast}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </div>

      {error && !loading && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 mb-4 text-xs text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
        </div>
      )}

      {/* Stat tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <StatCard
          title="Pending Now"
          value={forecast ? formatCurrency(forecast.totals.pendingNow) : '—'}
          subtitle="current queue, gross"
        />
        <StatCard
          title="Expected (P50)"
          value={forecast ? formatCurrency(forecast.totals.expectedP50) : '—'}
          subtitle={`over ${horizonDays}d, net of deductions`}
        />
        <StatCard
          title="Worst-Case (P90)"
          value={forecast ? formatCurrency(forecast.totals.expectedP90) : '—'}
          subtitle="higher approvals, lower deductions"
        />
      </div>

      {/* Chart */}
      <div className="h-[260px] rounded-lg border border-white/10 bg-black/20 p-2">
        {loading && !forecast ? (
          <div className="flex items-center justify-center h-full text-xs text-gray-500">
            <RefreshCw className="h-4 w-4 animate-spin mr-2" /> Loading forecast...
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-gray-500">No forecast data available.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} tickLine={false} />
              <YAxis
                tick={{ fill: '#6b7280', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => formatCurrency(v)}
                width={70}
              />
              <Tooltip content={<ForecastTooltip />} />
              <Legend wrapperStyle={{ fontSize: '10px', color: '#9ca3af' }} />
              <Area
                type="monotone"
                dataKey="pendingComponent"
                name="Pending payouts"
                stackId="liability"
                stroke={COLOR_PENDING}
                fill={COLOR_PENDING}
                fillOpacity={0.55}
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="pipelineComponent"
                name="Funded pipeline"
                stackId="liability"
                stroke={COLOR_PIPELINE}
                fill={COLOR_PIPELINE}
                fillOpacity={0.55}
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="bandSpread"
                name="P50–P90 band"
                stackId="liability"
                stroke={COLOR_BAND}
                fill={COLOR_BAND}
                fillOpacity={0.2}
                strokeWidth={1}
                strokeDasharray="4 3"
              />
              <Line
                type="monotone"
                dataKey="p50"
                name="P50 (expected)"
                stroke={COLOR_P50_LINE}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Scenario controls */}
      <div className="mt-4 rounded-lg border border-white/10 bg-black/20 p-3">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Scenario</span>
          {hasOverrides && (
            <button
              onClick={() => { setApprovalOverride(null); setDeductionOverride(null); }}
              className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
            >
              <RotateCcw className="h-3 w-3" /> Reset to historical
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
              <span>Approval rate</span>
              <span className="text-gray-300 font-medium">{formatPct(approvalRatePct / 100)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={approvalRatePct}
              onChange={(e) => setApprovalOverride(Number(e.target.value) / 100)}
              className="w-full accent-red-500"
            />
          </div>
          <div>
            <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
              <span>Avg. deduction rate</span>
              <span className="text-gray-300 font-medium">{formatPct(deductionRatePct / 100)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={deductionRatePct}
              onChange={(e) => setDeductionOverride(Number(e.target.value) / 100)}
              className="w-full accent-red-500"
            />
          </div>
        </div>
        {forecast && (
          <p className="mt-3 text-[10px] text-gray-600">
            {forecast.assumptions.fundedNearTargetCount} funded account{forecast.assumptions.fundedNearTargetCount !== 1 ? 's' : ''} trending toward the payout-eligibility target, feeding the pipeline component above.
          </p>
        )}
      </div>
    </GlassCard>
  );
}
