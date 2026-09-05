'use client';

import { GlassCard } from '@/components/ui/glass-card';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

interface RuleOutcome {
  ruleId: string;
  action: string | null;
}

interface AccountImpact {
  accountId: string;
  login: string;
  newBreaches: RuleOutcome[];
  clearedBreaches: RuleOutcome[];
  actionChanges: Array<{ ruleId: string; from: string; to: string }>;
}

interface ImpactReportView {
  accountsEvaluated: number;
  changed: AccountImpact[];
  unchangedCount: number;
  newTerminations: number;
  summary: string;
}

/**
 * Which currently-open accounts would change status if this pack went live.
 *
 * Newly-terminated accounts are surfaced first and loudest: that is the
 * one-keystroke-breaches-forty-accounts scenario this preview exists to
 * catch before a firm discovers it after publishing.
 */
export function ImpactView({ report, note }: { report: ImpactReportView; note?: string }) {
  const hasTerminations = report.newTerminations > 0;

  return (
    <div className="space-y-3">
      <GlassCard
        padding="md"
        glow={hasTerminations ? 'red' : 'none'}
        className={hasTerminations ? 'border-red-500/40' : report.changed.length > 0 ? 'border-orange-500/30' : 'border-emerald-500/30 bg-emerald-500/5'}
      >
        <div className="flex items-start gap-3">
          {hasTerminations || report.changed.length > 0 ? (
            <AlertTriangle className={`h-5 w-5 shrink-0 mt-0.5 ${hasTerminations ? 'text-red-400' : 'text-orange-400'}`} />
          ) : (
            <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
          )}
          <div>
            <p
              className={`text-sm font-semibold ${
                hasTerminations ? 'text-red-400' : report.changed.length > 0 ? 'text-orange-400' : 'text-emerald-400'
              }`}
            >
              {report.summary}
            </p>
            {note && <p className="text-[10px] text-gray-500 mt-1.5">{note}</p>}
          </div>
        </div>
      </GlassCard>

      {report.changed.length > 0 && (
        <GlassCard padding="sm">
          <p className="text-sm font-semibold text-white mb-2">
            Accounts that change status ({report.changed.length})
          </p>
          <ul className="space-y-2 max-h-72 overflow-y-auto">
            {report.changed.map((a) => (
              <li key={a.accountId} className="border border-white/10 rounded-xl p-2.5">
                <p className="text-[11px] font-medium text-gray-200 mb-1">{a.login}</p>
                <div className="flex flex-wrap gap-1.5">
                  {a.newBreaches.map((b, i) => (
                    <Badge key={`new-${i}`} variant={b.action === 'terminate' ? 'red' : 'yellow'}>
                      new: {b.ruleId} → {b.action}
                    </Badge>
                  ))}
                  {a.clearedBreaches.map((b, i) => (
                    <Badge key={`cleared-${i}`} variant="green">
                      cleared: {b.ruleId}
                    </Badge>
                  ))}
                  {a.actionChanges.map((c, i) => (
                    <Badge key={`change-${i}`} variant="blue">
                      {c.ruleId}: {c.from} → {c.to}
                    </Badge>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </GlassCard>
      )}
    </div>
  );
}
