'use client';

import { GlassCard } from '@/components/ui/glass-card';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';

interface ReconciliationEntry {
  accountId: string;
  ruleId: string;
  sessionDay?: string;
  detail: string;
}

interface BacktestResultView {
  accountsEvaluated: number;
  engineBreaches: number;
  providerBreaches: number;
  reconciliation: {
    engineOnly: ReconciliationEntry[];
    providerOnly: ReconciliationEntry[];
    agreed: ReconciliationEntry[];
  };
  skipped: Array<{ ruleId: string; reason: string }>;
  verdict: { safeToActivate: boolean; summary: string };
}

/**
 * The most important screen in the product.
 *
 * `providerOnly` is rendered first and loudest: every entry in it is a breach
 * the firm's own platform enforced that this pack would have missed, which is
 * the one failure mode — silently relaxing a firm's rules — this whole flow
 * exists to catch before a pack goes live. The verdict banner states
 * `safeToActivate` in words, never as a colour alone.
 */
export function ReconciliationView({ result }: { result: BacktestResultView }) {
  const { reconciliation: r, verdict } = result;

  return (
    <div className="space-y-4">
      <GlassCard
        padding="md"
        glow={verdict.safeToActivate ? 'none' : 'red'}
        className={verdict.safeToActivate ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-red-500/40'}
      >
        <div className="flex items-start gap-3">
          {verdict.safeToActivate ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <XCircle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
          )}
          <div>
            <p className={`text-sm font-semibold ${verdict.safeToActivate ? 'text-emerald-400' : 'text-red-400'}`}>
              {verdict.safeToActivate ? 'Safe to activate' : 'Not safe to activate'}
            </p>
            <p className="text-[11px] text-gray-300 mt-1 leading-relaxed">{verdict.summary}</p>
          </div>
        </div>
      </GlassCard>

      <div className="grid grid-cols-3 gap-3 text-center">
        <GlassCard padding="sm">
          <p className="text-[10px] uppercase tracking-wider text-gray-500">Accounts evaluated</p>
          <p className="text-lg font-bold text-white mt-1">{result.accountsEvaluated}</p>
        </GlassCard>
        <GlassCard padding="sm">
          <p className="text-[10px] uppercase tracking-wider text-gray-500">Engine breaches</p>
          <p className="text-lg font-bold text-white mt-1">{result.engineBreaches}</p>
        </GlassCard>
        <GlassCard padding="sm">
          <p className="text-[10px] uppercase tracking-wider text-gray-500">Platform breaches</p>
          <p className="text-lg font-bold text-white mt-1">{result.providerBreaches}</p>
        </GlassCard>
      </div>

      <ReconciliationList
        title="Platform caught, engine missed"
        subtitle="The important list — each entry is a place this pack would relax the firm's rules."
        entries={r.providerOnly}
        tone="critical"
      />
      <ReconciliationList
        title="Agreed"
        subtitle="Breaches both the platform and this pack found."
        entries={r.agreed}
        tone="ok"
      />
      <ReconciliationList
        title="Engine found, platform did not report"
        subtitle="Not blocking — review in case one is a mis-set parameter rather than a genuine catch."
        entries={r.engineOnly}
        tone="info"
      />

      {result.skipped.length > 0 && (
        <GlassCard padding="sm" className="border-orange-500/30">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-4 w-4 text-orange-400" />
            <p className="text-sm font-semibold text-orange-400">Rules not evaluated ({result.skipped.length})</p>
          </div>
          <ul className="space-y-1">
            {result.skipped.map((s, i) => (
              <li key={i} className="text-[11px] text-gray-400">
                <Badge variant="yellow" className="mr-1.5">{s.ruleId}</Badge>
                {s.reason}
              </li>
            ))}
          </ul>
        </GlassCard>
      )}
    </div>
  );
}

function ReconciliationList({
  title,
  subtitle,
  entries,
  tone,
}: {
  title: string;
  subtitle: string;
  entries: ReconciliationEntry[];
  tone: 'critical' | 'ok' | 'info';
}) {
  const toneClass = tone === 'critical' ? 'border-red-500/30' : tone === 'ok' ? 'border-emerald-500/30' : 'border-white/10';
  const badgeVariant = tone === 'critical' ? 'red' : tone === 'ok' ? 'green' : 'blue';

  return (
    <GlassCard padding="sm" className={toneClass}>
      <div className="flex items-center gap-2 mb-1">
        <p className="text-sm font-semibold text-white">{title}</p>
        <Badge variant={badgeVariant}>{entries.length}</Badge>
      </div>
      <p className="text-[10px] text-gray-500 mb-2">{subtitle}</p>
      {entries.length === 0 ? (
        <p className="text-[11px] text-gray-600">None.</p>
      ) : (
        <ul className="space-y-1 max-h-48 overflow-y-auto">
          {entries.map((e, i) => (
            <li key={i} className="text-[11px] text-gray-300 flex gap-2">
              <Badge variant="silver">{e.ruleId}</Badge>
              <span className="text-gray-500">{e.accountId}</span>
              <span className="truncate">{e.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </GlassCard>
  );
}
