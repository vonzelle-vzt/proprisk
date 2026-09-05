import { brand } from '@/config/brand';
import { buildViolationById, buildViolationDetail } from '@/lib/mock/builders';
import { violationLabel } from '@/lib/violations/labels';
import { legacyLimitSentence, usd } from './build';
import { VIOLATION_REPORT_SCHEMA_VERSION, type ViolationReport } from './types';

/**
 * The demo-mode report.
 *
 * Structural rule of demo mode (src/lib/demo): nothing here may touch
 * Supabase. That is why this file assembles from the mock dataset directly
 * instead of going through `buildViolationReport`, which persists.
 *
 * It also FABRICATES NOTHING. The mock dataset has no enforcement queue, no
 * equity snapshots, no dispute history and no audit chain, so those sections
 * come back empty and `provenance.dataFidelity` says why — inventing a
 * plausible approver or a plausible intraday peak would teach a demo viewer
 * that the product asserts things it cannot evidence, which is the opposite
 * of what this report exists to prove.
 */

/** Stable, non-random id: the same demo violation always reports the same id. */
function demoReportId(violationId: string): string {
  return `demo-${violationId}`;
}

export function buildDemoViolationReport(violationId: string): ViolationReport | null {
  const row = buildViolationById(violationId);
  if (!row) return null;

  const detail = buildViolationDetail(row.accountId);
  const typeKey = String(row.violationType);

  // Only the trades the mock itself attributes to THIS violation type.
  const flagged = (detail.flaggedTrades ?? []).filter((t) => t.type === typeKey);

  const trades: ViolationReport['trades'] = flagged
    .map((t) => ({
      id: String(t.tradeId),
      symbol: String(t.symbol),
      side: String(t.side),
      volume: Number(t.lots),
      openedAt: String(t.openTime),
      closedAt: String(t.closeTime),
      openPrice: Number(t.openPrice),
      closePrice: Number(t.closePrice),
      pnl: Number(t.profit),
      flagged: true,
    }))
    .sort((a, b) => (a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : a.id < b.id ? -1 : 1));

  const tradePnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const deduction = Number(row.deductionAmount ?? 0);

  const priorViolations = (detail.violationBreakdown ?? [])
    .filter((v) => v.type !== typeKey)
    .map((v) => ({
      id: `${row.accountId}-${v.type}`,
      ruleLabel: violationLabel(String(v.type)),
      detectedAt: String(row.detectedAt),
      status: 'detected',
    }));

  return {
    schemaVersion: VIOLATION_REPORT_SCHEMA_VERSION,
    reportId: demoReportId(violationId),
    generatedAt: String(row.detectedAt),
    generatedBy: 'demo',

    header: {
      firmName: brand.companyName,
      accountId: String(row.accountId),
      login: String(row.login),
      traderName: `${row.firstName} ${row.lastName}`.trim(),
      assetClass: row.assetClass,
      planName: String(row.plan),
    },

    rule: {
      id: typeKey,
      label: violationLabel(typeKey),
      limitAsWritten: legacyLimitSentence(typeKey, {
        accountSize: Number(row.startingBalance),
        assetClass: row.assetClass === 'futures' ? undefined : 'forex',
      }),
      source: 'legacy_engine',
    },

    whatHappened: {
      observed: String(row.explanation),
      severity: String(row.severity),
      detectedAt: String(row.detectedAt),
      status: 'detected',
    },

    arithmetic: [
      { label: 'Deduction recommended', value: usd(deduction) },
      {
        label: 'P&L across cited trades',
        expression: `${trades.length} trade(s)`,
        value: usd(tradePnl),
      },
      {
        label: 'Deduction as share of starting balance',
        expression: `${usd(deduction)} / ${usd(Number(row.startingBalance))}`,
        value: `${((deduction / Math.max(1, Number(row.startingBalance))) * 100).toFixed(2)}%`,
      },
    ],

    timeline: [
      ...trades.map((t) => ({
        at: t.openedAt,
        kind: 'trade' as const,
        summary: `${t.side} ${t.volume} ${t.symbol} (cited)`,
      })),
      {
        at: String(row.detectedAt),
        kind: 'detected' as const,
        summary: `${violationLabel(typeKey)} detected by the legacy engine`,
      },
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),

    trades,

    accountSnapshot: {
      // The demo dataset carries a balance and a starting balance and nothing
      // else. Equity is reported as the balance because that is the only
      // figure it has — flagged in dataFidelity rather than silently implied.
      balance: Number(detail.balance ?? 0),
      equity: Number(detail.balance ?? 0),
      startingBalance: Number(row.startingBalance),
    },

    action: {},

    history: { priorViolations, disputes: [] },

    provenance: {
      dataFidelity: [
        'Demo dataset: no equity snapshots exist, so no intraday peak can be shown.',
        'Demo dataset: equity is reported as the account balance — the fixtures carry no separate equity figure.',
        'Demo dataset: no enforcement-queue decision, deduction execution, dispute or audit-chain entry exists for this violation.',
        'Detected by the legacy engine, whose thresholds are code constants (src/config/violations.ts) rather than a versioned rule pack.',
      ],
      sourceRows: {
        violation: true,
        breachDecision: false,
        evidencePack: false,
        enforcementQueue: false,
      },
    },
  };
}
