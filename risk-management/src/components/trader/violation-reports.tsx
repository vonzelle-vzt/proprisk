import { GlassCard } from '@/components/ui/glass-card';
import { Badge } from '@/components/ui/badge';
import { SEVERITY_BADGE } from '@/components/risk/constants';
import type { TraderViolationSummary } from '@/lib/trader/data';

/**
 * The trader's own decision records (docs/HOW-IT-WORKS.md §2 Flow 3: "Full
 * decision record: [link]").
 *
 * Server-rendered plain links — no client JavaScript on this surface at all,
 * so the page keeps working for a trader on a locked-down device, and the
 * token never reaches a client bundle beyond the URL it is already in.
 *
 * Severity is shown as a coloured badge AND the word, per DESIGN.md: colour
 * is never the only carrier of a risk signal. The hue comes from the shared
 * `SEVERITY_BADGE` map rather than a local one.
 */

function utcStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function ViolationReports({
  token,
  violations,
}: {
  token: string;
  violations: TraderViolationSummary[];
}) {
  if (violations.length === 0) return null;

  return (
    <GlassCard padding="md">
      <p className="mb-1 text-sm uppercase tracking-wider text-gray-400">Decision records</p>
      <p className="mb-3 text-sm text-gray-500">
        The full record behind each rule decision on this account — the rule as written, what
        happened, the arithmetic, and the trades.
      </p>
      <div className="flex flex-col divide-y divide-white/10">
        {violations.map((v) => {
          const base = `/api/trader/${encodeURIComponent(token)}/violations/${encodeURIComponent(v.id)}/report`;
          return (
            <div key={v.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-base text-white">{v.ruleLabel}</p>
                  <Badge variant={SEVERITY_BADGE[v.severity] ?? 'silver'}>{v.severity}</Badge>
                </div>
                <p className="text-sm text-gray-500">{utcStamp(v.detectedAt)}</p>
              </div>
              <div className="flex items-center gap-3">
                <a
                  href={`${base}?format=pdf`}
                  download
                  className="rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-gray-200 hover:bg-white/20"
                >
                  PDF
                </a>
                <a
                  href={`${base}?format=csv`}
                  download
                  className="rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-gray-200 hover:bg-white/20"
                >
                  CSV
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </GlassCard>
  );
}
