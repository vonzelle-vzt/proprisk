import { describe, expect, it } from 'vitest';
import { renderViolationReportPdf } from './render-pdf';
import { contentHashOf } from './build';
import type { ViolationReport } from './types';

/**
 * pdfkit writes text as hex-encoded WinAnsi glyph runs inside `[...] TJ`
 * arrays, even with `compress: false` — kerning splits a single word across
 * several `<hex>` segments separated by numeric offsets. A raw substring
 * search for "Violation report" therefore CANNOT match, so this decodes the
 * runs back to text first. It is still a check against the real bytes: the
 * only thing being undone is pdfkit's own encoding.
 */
function extractPdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const lines: string[] = [];
  for (const match of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    const run = [...match[1].matchAll(/<([0-9a-fA-F]*)>/g)]
      .map((hex) => Buffer.from(hex[1], 'hex').toString('latin1'))
      .join('');
    if (run) lines.push(run);
  }
  return lines.join('\n');
}

/**
 * Extracts every `<x> <y> Tm ... TJ` text run as `{ x, text }`, decoding the
 * same hex-glyph runs as `extractPdfText`. Each run is one `doc.text(...)`
 * call's output on one line, so this lets a test assert WHERE a given piece
 * of text was placed, not just that it exists somewhere in the stream.
 */
function extractPositionedRuns(pdf: Buffer): Array<{ x: number; text: string }> {
  const raw = pdf.toString('latin1');
  const runs: Array<{ x: number; text: string }> = [];
  const blockRe = /1 0 0 1 ([\d.]+) [\d.]+ Tm[\s\S]*?\[([^\]]*)\]\s*TJ/g;
  for (const match of raw.matchAll(blockRe)) {
    const x = Number(match[1]);
    const text = [...match[2].matchAll(/<([0-9a-fA-F]*)>/g)]
      .map((hex) => Buffer.from(hex[1], 'hex').toString('latin1'))
      .join('');
    if (text) runs.push({ x, text });
  }
  return runs;
}

function report(overrides: Partial<ViolationReport> = {}): ViolationReport {
  return {
    schemaVersion: 1,
    reportId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    generatedAt: '2026-03-03T09:00:00.000Z',
    generatedBy: 'dana@firm.com',
    header: {
      firmName: 'Northwind Prop',
      accountId: '33333333-3333-3333-3333-333333333333',
      login: '1001',
      traderName: 'Maria Garcia',
      phase: 'funded',
      assetClass: 'forex',
      planName: 'pro',
    },
    rule: {
      id: 'daily_loss',
      label: 'Daily Loss Limit',
      limitAsWritten: 'maximum daily loss of $5,000.00 (5.00% of the $100,000.00 starting balance)',
      source: 'rule_pack',
      pack: { id: 'pack-1', name: 'House rules', version: 3, contentHash: 'packhash123' },
      action: 'terminate',
    },
    whatHappened: {
      observed: 'lost $6,000.00 across 4 trades on the 2026-03-02 session',
      exceededBy: 1000,
      sessionDay: '2026-03-02',
      severity: 'critical',
      detectedAt: '2026-03-02T21:05:00.000Z',
      status: 'detected',
    },
    arithmetic: [
      {
        label: 'Breach arithmetic',
        expression: 'peak equity $102,500.00 - closing equity $96,500.00 = $6,000.00',
        value: '',
      },
      { label: 'Exceeded limit by', value: '$1,000.00' },
    ],
    timeline: [
      { at: '2026-03-02T14:00:00.000Z', kind: 'trade', summary: 'buy 2.5 EURUSD (cited)' },
      { at: '2026-03-02T21:05:00.000Z', kind: 'detected', summary: 'Daily Loss Limit detected' },
    ],
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
    accountSnapshot: {
      balance: 96500,
      equity: 96500,
      startingBalance: 100000,
      startingDayBalance: 102500,
      startingDayEquity: 102500,
    },
    action: {
      queueStatus: 'approved',
      decision: 'approved',
      approver: 'dana@firm.com',
      decidedAt: '2026-03-03T08:00:00.000Z',
    },
    history: {
      priorViolations: [
        { id: 'v-old', ruleLabel: 'HFT', detectedAt: '2026-02-10T09:00:00.000Z', status: 'dismissed' },
      ],
      disputes: [],
    },
    provenance: {
      dataFidelity: ['No equity snapshots retained for this session day (2026-03-02).'],
      auditHash: 'auditbeef',
      sourceRows: {
        violation: true,
        breachDecision: true,
        evidencePack: false,
        enforcementQueue: true,
      },
    },
    ...overrides,
  };
}

describe('renderViolationReportPdf', () => {
  it('emits a PDF', async () => {
    const pdf = await renderViolationReportPdf(report());
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.subarray(-6).toString('latin1').trim()).toBe('%%EOF');
  });

  /**
   * The load-bearing property: a decision record that renders differently on
   * two days cannot be shown to be the same document a trader received. This
   * is what pins `info.CreationDate`/`ModDate` (pdfkit would otherwise stamp
   * the wall clock, and derive the trailer /ID from it).
   */
  it('is byte-identical across two renders of the same report', async () => {
    const input = report();
    const [a, b] = await Promise.all([
      renderViolationReportPdf(input),
      renderViolationReportPdf(input),
    ]);
    expect(a.equals(b)).toBe(true);
  });

  it('pins the PDF creation date to the report, not the clock', async () => {
    const pdf = await renderViolationReportPdf(report());
    expect(pdf.toString('latin1')).toContain('(D:20260303090000Z)');
  });

  it('carries the title, the firm and the account login as real text', async () => {
    const text = extractPdfText(await renderViolationReportPdf(report()));
    expect(text).toContain('Violation report');
    expect(text).toContain('Northwind Prop');
    expect(text).toContain('1001');
    expect(text).toContain('Maria Garcia');
  });

  it('states the severity as a WORD, never as colour alone', async () => {
    const text = extractPdfText(await renderViolationReportPdf(report()));
    expect(text).toContain('CRITICAL');
  });

  it('quotes the rule, the arithmetic and the fidelity limits', async () => {
    const text = extractPdfText(await renderViolationReportPdf(report()));
    expect(text).toContain('THE RULE');
    expect(text).toContain('maximum daily loss of $5,000.00');
    expect(text).toContain('peak equity $102,500.00');
    expect(text).toContain('No equity snapshots retained');
  });

  it('footers every page with the report id, the content hash and page x of y', async () => {
    const input = report();
    const text = extractPdfText(await renderViolationReportPdf(input));
    const hash12 = contentHashOf(input).slice(0, 12);

    expect(text).toContain(`report ${input.reportId}`);
    expect(text).toContain(`sha256 ${hash12}`);
    expect(text).toMatch(/page 1 of \d+/);
  });

  it('page-breaks a long trades table and numbers every page', async () => {
    const many = report({
      trades: Array.from({ length: 140 }, (_, i) => ({
        id: `T-${9000 + i}`,
        symbol: 'EURUSD',
        side: i % 2 === 0 ? 'buy' : 'sell',
        volume: 1 + (i % 5) / 10,
        openedAt: `2026-03-02T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
        closedAt: `2026-03-02T${String(i % 24).padStart(2, '0')}:30:00.000Z`,
        pnl: -100 - i,
        flagged: i % 3 === 0,
      })),
    });

    const text = extractPdfText(await renderViolationReportPdf(many));
    const pageLabels = [...text.matchAll(/page (\d+) of (\d+)/g)];
    const total = Number(pageLabels[0][2]);

    expect(total).toBeGreaterThan(1);
    // One footer per page, numbered 1..total.
    expect(pageLabels).toHaveLength(total);
    expect(pageLabels.map((m) => Number(m[1]))).toEqual(
      Array.from({ length: total }, (_, i) => i + 1)
    );
    // The header row is repeated on every page the table continues onto.
    expect(text.split('Trade').length - 1).toBeGreaterThan(1);
  });

  /**
   * Regression for the drift bug: a section heading drawn immediately after
   * a table used to inherit `doc.x` from wherever the table's last cell left
   * the text cursor (the right-hand edge of the last column), rather than
   * the left margin — and with no explicit width, that narrow leftover span
   * made "ACCOUNT AT DETECTION" wrap one word per line. Long tables (trades,
   * timeline, history) exercise the exact cursor state that triggered it.
   */
  it('starts every section heading at the left margin, even right after a table', async () => {
    const margin = 48;
    const many = report({
      trades: Array.from({ length: 20 }, (_, i) => ({
        id: `T-${9000 + i}`,
        symbol: 'EURUSD',
        side: i % 2 === 0 ? 'buy' : 'sell',
        volume: 1 + (i % 5) / 10,
        openedAt: `2026-03-02T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
        closedAt: `2026-03-02T${String(i % 24).padStart(2, '0')}:30:00.000Z`,
        pnl: -100 - i,
        flagged: i % 3 === 0,
      })),
    });

    const pdf = await renderViolationReportPdf(many);
    const runs = extractPositionedRuns(pdf);

    const headings = [
      'THE RULE',
      'WHAT HAPPENED',
      'THE ARITHMETIC',
      'TIMELINE',
      'THE TRADES',
      'ACCOUNT AT DETECTION',
      'ACTION TAKEN',
      'HISTORY',
      'PROVENANCE AND DATA FIDELITY',
    ];

    for (const heading of headings) {
      const matches = runs.filter((r) => r.text === heading);
      // Never wrapped: the full heading is one run, not split across lines.
      expect(matches.length).toBe(1);
      expect(matches[0].x).toBe(margin);
    }
  });

  it('renders a report with every optional field absent', async () => {
    const bare = report({
      header: { firmName: 'F', accountId: 'a', login: 'l' },
      rule: { id: 'r', label: 'R', limitAsWritten: 'L', source: 'legacy_engine' },
      whatHappened: {
        observed: 'o',
        severity: 'unknown-severity',
        detectedAt: '2026-03-02T21:05:00.000Z',
        status: 'detected',
      },
      arithmetic: [],
      timeline: [],
      trades: [],
      accountSnapshot: { balance: 0, equity: 0, startingBalance: 0 },
      action: {},
      history: { priorViolations: [], disputes: [] },
      provenance: {
        dataFidelity: [],
        sourceRows: {
          violation: true,
          breachDecision: false,
          evidencePack: false,
          enforcementQueue: false,
        },
      },
    });

    const pdf = await renderViolationReportPdf(bare);
    const text = extractPdfText(pdf);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(text).toContain('None recorded');
    // An unmapped severity still prints its word rather than falling silent.
    expect(text).toContain('UNKNOWN-SEVERITY');
  });
});
