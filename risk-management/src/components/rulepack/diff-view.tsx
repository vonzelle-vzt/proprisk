'use client';

import { GlassCard } from '@/components/ui/glass-card';
import { Badge } from '@/components/ui/badge';

interface RulePackChange {
  ruleId: string;
  kind: 'added' | 'removed' | 'changed';
  summary: string;
}

interface RulePackDiffView {
  changes: RulePackChange[];
  identical: boolean;
}

const KIND_BADGE: Record<RulePackChange['kind'], { variant: 'green' | 'red' | 'yellow'; label: string }> = {
  added: { variant: 'green', label: '+ added' },
  removed: { variant: 'red', label: '− removed' },
  changed: { variant: 'yellow', label: '~ changed' },
};

/** Plain-language change list, read before every publish. */
export function DiffView({ diff, against }: { diff: RulePackDiffView; against?: string }) {
  if (diff.identical) {
    return (
      <GlassCard padding="sm" className="border-white/10">
        <p className="text-[11px] text-gray-400">
          No rule changes{against ? ` from ${against}` : ''}.
        </p>
      </GlassCard>
    );
  }

  return (
    <GlassCard padding="sm">
      <p className="text-sm font-semibold text-white mb-2">
        Changes{against ? ` from ${against}` : ''} ({diff.changes.length})
      </p>
      <ul className="space-y-1.5">
        {diff.changes.map((c, i) => {
          const badge = KIND_BADGE[c.kind];
          return (
            <li key={i} className="flex items-start gap-2 text-[11px] text-gray-300">
              <Badge variant={badge.variant} className="shrink-0 mt-0.5">{badge.label}</Badge>
              <span>{c.summary}</span>
            </li>
          );
        })}
      </ul>
    </GlassCard>
  );
}
