'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Printer, Download } from 'lucide-react';
import { brand } from '@/config/brand';
import { formatCurrency, formatDateTime } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import type { EvidencePack, RuleVerdict } from '@/lib/evidence/types';

/**
 * Print-optimized evidence-pack dossier — the "why we did this" artifact
 * for a payout / violation / account / investigation decision. Matches the
 * dashboard dark theme on screen; the `@media print` rules below hide the
 * dashboard chrome (sidebar/header, owned elsewhere) via a visibility trick
 * scoped to #evidence-pack-print so this page never has to touch that markup.
 */

const VERDICT_STYLE: Record<RuleVerdict, string> = {
  breach: 'bg-red-500/20 text-red-400 border-red-500/30 print:bg-red-50 print:text-red-700 print:border-red-300',
  warning: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30 print:bg-yellow-50 print:text-yellow-700 print:border-yellow-300',
  pass: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30 print:bg-emerald-50 print:text-emerald-700 print:border-emerald-300',
};

const SUBJECT_LABEL: Record<string, string> = {
  payout: 'Payout',
  violation: 'Violation',
  account: 'Account Review',
  investigation: 'Investigation',
};

function SectionCard({
  title,
  children,
  breakBefore,
}: {
  title: string;
  children: React.ReactNode;
  breakBefore?: boolean;
}) {
  return (
    <section
      className={cn(
        'rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl p-6 print:rounded-none print:border-gray-300 print:bg-white print:shadow-none print:backdrop-blur-none',
        breakBefore && 'print:break-before-page'
      )}
    >
      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 print:text-gray-600 mb-4">{title}</h2>
      {children}
    </section>
  );
}

function EmptyRow({ span }: { span: number }) {
  return (
    <tr>
      <td colSpan={span} className="px-3 py-3 text-xs text-gray-500 print:text-gray-500 text-center">
        None on record.
      </td>
    </tr>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400 print:text-gray-600 whitespace-nowrap border-b border-white/10 print:border-gray-300">
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={cn('px-3 py-2 text-xs text-gray-300 print:text-gray-800 align-top', className)}>{children}</td>
  );
}

function downloadJSON(pack: EvidencePack) {
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `evidence-pack-${pack.id}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function EvidencePackPage() {
  const params = useParams();
  const router = useRouter();
  const id = String(params.id);
  const [pack, setPack] = useState<EvidencePack | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/evidence/${id}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setPack(json.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load evidence pack');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">Loading evidence pack...</div>;
  }
  if (error || !pack) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-500">
        <p>{error || 'Evidence pack not found'}</p>
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
      </div>
    );
  }

  const { sections } = pack;

  return (
    <div id="evidence-pack-print" className="text-gray-200 print:text-black">
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #evidence-pack-print, #evidence-pack-print * { visibility: visible; }
          #evidence-pack-print {
            position: absolute;
            inset: 0;
            width: 100%;
            margin: 0;
            padding: 0;
            background: #ffffff;
          }
          @page { size: A4; margin: 14mm; }
        }
      `}</style>

      <div className="flex items-center justify-between mb-6 print:hidden">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => downloadJSON(pack)}>
            <Download className="h-3.5 w-3.5 mr-1" /> Export JSON
          </Button>
          <Button variant="primary" size="sm" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5 mr-1" /> Print / Save as PDF
          </Button>
        </div>
      </div>

      <div className="space-y-6 print:space-y-4">
        {/* Brand header */}
        <div className="flex items-center justify-between border-b border-white/10 print:border-gray-300 pb-4">
          <div>
            <p className="text-lg font-semibold text-white print:text-black">{brand.productName}</p>
            <p className="text-xs text-gray-500 print:text-gray-600">{brand.companyName}</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider text-gray-500 print:text-gray-600">Evidence Pack</p>
            <p className="text-xs font-mono text-gray-400 print:text-gray-600">{pack.id}</p>
          </div>
        </div>

        {/* Title + subject metadata */}
        <div>
          <h1 className="text-xl font-bold text-white print:text-black mb-3">{pack.title}</h1>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-xs text-gray-500 print:text-gray-600">Subject Type</span>
              <p className="text-white print:text-black">{SUBJECT_LABEL[pack.subjectType] ?? pack.subjectType}</p>
            </div>
            <div>
              <span className="text-xs text-gray-500 print:text-gray-600">Subject ID</span>
              <p className="font-mono text-gray-300 print:text-gray-800">{pack.subjectId}</p>
            </div>
            <div>
              <span className="text-xs text-gray-500 print:text-gray-600">Account</span>
              <p className="font-mono text-gray-300 print:text-gray-800">{pack.accountId ?? '—'}</p>
            </div>
            <div>
              <span className="text-xs text-gray-500 print:text-gray-600">Asset Class</span>
              <p className="text-white print:text-black capitalize">{pack.assetClass ?? '—'}</p>
            </div>
          </div>
        </div>

        {/* Executive summary / narrative */}
        <SectionCard title="Executive Summary">
          <p className="text-sm leading-relaxed text-gray-200 print:text-gray-900 whitespace-pre-wrap">
            {pack.narrative || 'No narrative available.'}
          </p>
        </SectionCard>

        {/* Account summary */}
        <SectionCard title="Account Summary">
          {Object.keys(sections.accountSummary).length === 0 ? (
            <p className="text-xs text-gray-500">No account data on record.</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-xs">
              {Object.entries(sections.accountSummary).map(([key, value]) => (
                <div key={key}>
                  <span className="block text-gray-500 print:text-gray-600 capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                  <span className="text-gray-200 print:text-gray-900 break-words">
                    {typeof value === 'number' ? value.toLocaleString() : String(value ?? '—')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* Scoring trail */}
        <SectionCard title="Scoring Trail">
          {sections.scoringTrail.length === 0 ? (
            <p className="text-xs text-gray-500">No rule findings on record.</p>
          ) : (
            <div className="space-y-4">
              {sections.scoringTrail.map((finding) => (
                <div key={finding.ruleId} className="rounded-xl border border-white/10 print:border-gray-300 overflow-hidden">
                  <div className="flex flex-wrap items-center gap-3 px-3 py-2 bg-white/5 print:bg-gray-50 border-b border-white/10 print:border-gray-300">
                    <span className="text-sm font-semibold text-white print:text-black">{finding.ruleLabel}</span>
                    <span className={cn('inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border', VERDICT_STYLE[finding.verdict])}>
                      {finding.verdict.toUpperCase()}
                    </span>
                    <span className="ml-auto text-sm font-semibold text-red-400 print:text-red-700">
                      -{formatCurrency(finding.deductionAmount)}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 px-3 py-2 text-xs">
                    <div>
                      <span className="block text-gray-500 print:text-gray-600">Threshold</span>
                      <span className="text-gray-300 print:text-gray-800">{finding.threshold}</span>
                    </div>
                    <div>
                      <span className="block text-gray-500 print:text-gray-600">Observed</span>
                      <span className="text-gray-300 print:text-gray-800">{finding.observed}</span>
                    </div>
                  </div>
                  {finding.evidence.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr>
                            <Th>Trade ID</Th>
                            <Th>Symbol</Th>
                            <Th>Open</Th>
                            <Th>Close</Th>
                            <Th>Lots</Th>
                            <Th>Profit</Th>
                            <Th>Note</Th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5 print:divide-gray-200">
                          {finding.evidence.map((row) => (
                            <tr key={row.tradeId}>
                              <Td className="font-mono">{row.tradeId}</Td>
                              <Td>{row.symbol}</Td>
                              <Td>{row.openTime ? formatDateTime(row.openTime) : '—'}</Td>
                              <Td>{row.closeTime ? formatDateTime(row.closeTime) : '—'}</Td>
                              <Td>{row.lots.toFixed(2)}</Td>
                              <Td className={row.profit >= 0 ? 'text-emerald-400 print:text-emerald-700' : 'text-red-400 print:text-red-700'}>
                                {formatCurrency(row.profit)}
                              </Td>
                              <Td>{row.note ?? '—'}</Td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* Deduction math */}
        <SectionCard title="Deduction Math">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Line</Th>
                  <Th>Amount</Th>
                  <Th>Note</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 print:divide-gray-200">
                {sections.deductionMath.length === 0 ? (
                  <EmptyRow span={3} />
                ) : (
                  sections.deductionMath.map((line, i) => (
                    <tr key={i}>
                      <Td>{line.label}</Td>
                      <Td className={line.amount < 0 ? 'text-red-400 print:text-red-700 font-semibold' : 'text-emerald-400 print:text-emerald-700 font-semibold'}>
                        {formatCurrency(line.amount)}
                      </Td>
                      <Td>{line.note ?? '—'}</Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>

        {/* News events */}
        <SectionCard title="News Events">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Title</Th>
                  <Th>Country</Th>
                  <Th>Date</Th>
                  <Th>Impact</Th>
                  <Th>Source</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 print:divide-gray-200">
                {sections.newsEvents.length === 0 ? (
                  <EmptyRow span={5} />
                ) : (
                  sections.newsEvents.map((evt, i) => (
                    <tr key={i}>
                      <Td>{evt.title}</Td>
                      <Td>{evt.country}</Td>
                      <Td>{formatDateTime(evt.date)}</Td>
                      <Td>{evt.impact}</Td>
                      <Td>{evt.source ?? '—'}</Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>

        {/* Network links */}
        <SectionCard title="Network Links">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Linked Account</Th>
                  <Th>Kind</Th>
                  <Th>Detail</Th>
                  <Th>Weight</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 print:divide-gray-200">
                {sections.networkLinks.length === 0 ? (
                  <EmptyRow span={4} />
                ) : (
                  sections.networkLinks.map((link, i) => (
                    <tr key={i}>
                      <Td className="font-mono">{link.accountId}</Td>
                      <Td>{link.kind}</Td>
                      <Td>{link.detail}</Td>
                      <Td>{(link.weight * 100).toFixed(0)}%</Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>

        {/* Decision history */}
        <SectionCard title="Decision History" breakBefore>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Decision</Th>
                  <Th>Actor</Th>
                  <Th>Decided At</Th>
                  <Th>Summary</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 print:divide-gray-200">
                {sections.decisionHistory.length === 0 ? (
                  <EmptyRow span={4} />
                ) : (
                  sections.decisionHistory.map((d) => (
                    <tr key={d.decisionId}>
                      <Td className="uppercase font-semibold">{d.decision}</Td>
                      <Td>{d.actor}</Td>
                      <Td>{formatDateTime(d.decidedAt)}</Td>
                      <Td>{d.summary}</Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>

        {/* Audit entries */}
        <SectionCard title="Audit Trail">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Action</Th>
                  <Th>Performed By</Th>
                  <Th>Occurred At</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 print:divide-gray-200">
                {sections.auditEntries.length === 0 ? (
                  <EmptyRow span={4} />
                ) : (
                  sections.auditEntries.map((entry, i) => (
                    <tr key={i}>
                      <Td>{entry.actionType}</Td>
                      <Td>{entry.performedBy}</Td>
                      <Td>{formatDateTime(entry.occurredAt)}</Td>
                      <Td className="max-w-md break-words">{entry.detail}</Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>

        {/* Footer */}
        <div className="flex items-center justify-between text-[10px] text-gray-500 print:text-gray-600 border-t border-white/10 print:border-gray-300 pt-4">
          <span>Generated {formatDateTime(pack.createdAt)}{pack.createdBy ? ` by ${pack.createdBy}` : ''}</span>
          <span className="font-mono">{pack.id}</span>
        </div>
      </div>
    </div>
  );
}
