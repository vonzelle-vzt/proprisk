import { describe, expect, it } from 'vitest';
import {
  renderAccountViolationsCsv,
  renderViolationReportCsv,
  VIOLATION_CSV_SECTIONS,
} from './render-csv';
import type { ViolationReport } from './types';

function report(overrides: Partial<ViolationReport> = {}): ViolationReport {
  return {
    schemaVersion: 1,
    reportId: 'report-1',
    generatedAt: '2026-03-03T09:00:00.000Z',
    generatedBy: 'dana@firm.com',
    header: {
      firmName: 'Northwind Prop',
      accountId: 'acct-1',
      login: '1001',
      traderName: 'Maria Garcia',
    },
    rule: {
      id: 'daily_loss',
      // Commas AND an embedded quote: the two things RFC 4180 quoting is for.
      label: 'Daily Loss, "hard" limit',
      limitAsWritten: 'maximum daily loss of $5,000.00, measured on equity',
      source: 'rule_pack',
      pack: { id: 'pack-1', name: 'House rules', version: 3, contentHash: 'packhash123' },
      action: 'terminate',
    },
    whatHappened: {
      observed: 'lost $6,000.00\nacross 4 trades',
      exceededBy: 1000,
      sessionDay: '2026-03-02',
      severity: 'critical',
      detectedAt: '2026-03-02T21:05:00.000Z',
      status: 'detected',
    },
    arithmetic: [{ label: 'Breach arithmetic', expression: 'a - b = c', value: '$6,000.00' }],
    timeline: [{ at: '2026-03-02T21:05:00.000Z', kind: 'detected', summary: 'detected' }],
    trades: [
      {
        id: 'T-9001',
        symbol: 'EURUSD',
        side: 'buy',
        volume: 2.5,
        openedAt: '2026-03-02T14:00:00.000Z',
        closedAt: '2026-03-02T15:30:00.000Z',
        openPrice: 1.0812,
        closePrice: 1.0765,
        pnl: -6000,
        flagged: true,
      },
    ],
    accountSnapshot: { balance: 96500, equity: 96500, startingBalance: 100000 },
    action: {
      queueStatus: 'approved',
      approver: 'dana@firm.com',
      deduction: { amount: 6000, preBalance: 102500, postBalance: 96500, executedBy: 'dana@firm.com' },
    },
    history: {
      priorViolations: [
        { id: 'v-old', ruleLabel: 'HFT', detectedAt: '2026-02-10T09:00:00.000Z', status: 'dismissed' },
      ],
      disputes: [
        { id: 'd-1', status: 'open', openedAt: '2026-03-04T10:00:00.000Z', resolution: undefined },
      ],
    },
    provenance: {
      dataFidelity: ['No equity snapshots retained for this session day (2026-03-02).'],
      auditHash: 'auditbeef',
      evidencePackId: 'pack-abc',
      sourceRows: {
        violation: true,
        breachDecision: true,
        evidencePack: true,
        enforcementQueue: true,
      },
    },
    ...overrides,
  };
}

describe('renderViolationReportCsv', () => {
  it('emits every section, in the order of the report type', () => {
    const csv = renderViolationReportCsv(report());
    const positions = VIOLATION_CSV_SECTIONS.map((title) => csv.indexOf(`\n${title}\n`));

    // Summary is first and therefore preceded only by the BOM.
    expect(csv.startsWith('﻿Summary\n')).toBe(true);
    for (const [i, pos] of positions.entries()) {
      if (i === 0) continue;
      expect(pos, `section ${VIOLATION_CSV_SECTIONS[i]} missing`).toBeGreaterThan(-1);
      expect(pos).toBeGreaterThan(positions[i - 1]);
    }
  });

  it('leads with the Excel BOM, as every other export in the product does', () => {
    expect(renderViolationReportCsv(report()).charCodeAt(0)).toBe(0xfeff);
  });

  it('quotes commas, embedded quotes and newlines per RFC 4180', () => {
    const csv = renderViolationReportCsv(report());
    expect(csv).toContain('"Daily Loss, ""hard"" limit"');
    expect(csv).toContain('"lost $6,000.00\nacross 4 trades"');
  });

  it('carries the rule as written, the pack identity and the arithmetic', () => {
    const csv = renderViolationReportCsv(report());
    expect(csv).toContain('Limit as written');
    expect(csv).toContain('House rules');
    expect(csv).toContain('packhash123');
    expect(csv).toContain('a - b = c');
  });

  it('records fidelity limits and the audit pointer under Provenance', () => {
    const csv = renderViolationReportCsv(report());
    const provenance = csv.slice(csv.indexOf('\nProvenance\n'));
    expect(provenance).toContain('auditbeef');
    expect(provenance).toContain('Data fidelity,No equity snapshots retained');
    expect(provenance).toContain('Source row: breach decision,yes');
  });

  it('renders a report with no trades, no history and no optional fields', () => {
    const csv = renderViolationReportCsv(
      report({
        trades: [],
        arithmetic: [],
        timeline: [],
        action: {},
        history: { priorViolations: [], disputes: [] },
        rule: { id: 'r', label: 'R', limitAsWritten: 'L', source: 'legacy_engine' },
        provenance: {
          dataFidelity: [],
          sourceRows: {
            violation: true,
            breachDecision: false,
            evidencePack: false,
            enforcementQueue: false,
          },
        },
      })
    );
    // Every section header is still emitted — an absent section would read as
    // "not applicable" rather than "nothing recorded".
    for (const title of VIOLATION_CSV_SECTIONS) {
      expect(csv).toContain(title === 'Summary' ? `﻿${title}\n` : `\n${title}\n`);
    }
    expect(csv).toContain('Rule pack name,—');
  });
});

describe('renderAccountViolationsCsv', () => {
  it('emits Summary then Trades, both keyed by violation_id', () => {
    const csv = renderAccountViolationsCsv([
      { violationId: 'v-1', report: report() },
      {
        violationId: 'v-2',
        report: report({
          reportId: 'report-2',
          whatHappened: { ...report().whatHappened, detectedAt: '2026-04-01T00:00:00.000Z' },
        }),
      },
    ]);

    expect(csv.startsWith('﻿Summary\n')).toBe(true);
    expect(csv.indexOf('\nTrades\n')).toBeGreaterThan(0);
    expect(csv).toContain('violation_id,Report id,Account id');
    expect(csv).toContain('violation_id,Report id,Trade id');
    expect(csv).toContain('v-1,report-1,');
    expect(csv).toContain('v-2,report-2,');
  });

  it('orders newest first', () => {
    const csv = renderAccountViolationsCsv([
      { violationId: 'old', report: report({ reportId: 'r-old' }) },
      {
        violationId: 'new',
        report: report({
          reportId: 'r-new',
          whatHappened: { ...report().whatHappened, detectedAt: '2026-09-01T00:00:00.000Z' },
        }),
      },
    ]);
    expect(csv.indexOf('new,r-new')).toBeLessThan(csv.indexOf('old,r-old'));
  });

  it('accepts bare reports and exports an empty violation id for them', () => {
    const csv = renderAccountViolationsCsv([report()]);
    expect(csv).toContain(',report-1,');
  });

  it('handles an account with no violations at all', () => {
    const csv = renderAccountViolationsCsv([]);
    expect(csv).toContain('Summary');
    expect(csv).toContain('Trades');
  });
});
