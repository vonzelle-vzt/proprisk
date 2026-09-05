'use client';

import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/ui/glass-card';
import { formatPercent } from '@/lib/utils/format';
import type { RuleOverturnRate } from '@/lib/disputes/types';
import { TrendingDown } from 'lucide-react';

/**
 * Per-rule overturn rate (docs/HOW-IT-WORKS.md §6.4): the one number no
 * competitor surfaces — which of a firm's own rules keeps producing
 * decisions the firm later reverses.
 */
export function OverturnRatePanel() {
  const [rows, setRows] = useState<RuleOverturnRate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/disputes/overturn-rate', { cache: 'no-store' })
      .then((res) => res.json())
      .then((json) => {
        if (!cancelled) setRows(json.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loading && rows.length === 0) return null;

  return (
    <GlassCard padding="sm">
      <div className="flex items-center gap-2 mb-3">
        <TrendingDown className="h-3.5 w-3.5 text-gray-500" />
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          Overturn Rate by Rule
        </h3>
      </div>
      {loading ? (
        <p className="text-xs text-gray-500">Loading...</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.ruleId} className="flex items-center gap-3">
              <span className="w-40 shrink-0 text-xs text-gray-300 truncate">{r.ruleLabel}</span>
              <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div
                  className={r.overturnRate >= 0.3 ? 'h-full bg-red-500' : r.overturnRate > 0 ? 'h-full bg-yellow-500' : 'h-full bg-emerald-500'}
                  style={{ width: `${Math.max(r.overturnRate * 100, 2)}%` }}
                />
              </div>
              <span className="w-28 shrink-0 text-right text-xs text-gray-400">
                {formatPercent(r.overturnRate)} ({r.overturned}/{r.totalResolved})
              </span>
            </div>
          ))}
        </div>
      )}
    </GlassCard>
  );
}
