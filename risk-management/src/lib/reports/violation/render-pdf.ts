import PDFDocument from 'pdfkit';
import { brand } from '@/config/brand';
import { contentHashOf, usd } from './build';
import type { ViolationReport } from './types';

/**
 * Renders a `ViolationReport` to PDF.
 *
 * DETERMINISM IS A REQUIREMENT, NOT A NICETY. The same report must produce
 * byte-identical output every time, so that a PDF a trader received in March
 * can be shown to be the same document the firm still holds in September.
 * Three things would break that and are handled explicitly:
 *
 *   - pdfkit defaults `info.CreationDate` to `new Date()`. Both CreationDate
 *     and ModDate are pinned to `report.generatedAt`.
 *   - the trailer `/ID` is `PDFSecurity.generateFileID(info)` — a digest of
 *     the info dictionary, so pinning the dates pins the id too.
 *   - `compress: false` keeps the content streams as plain deflate-free bytes,
 *     which also makes the output diffable and testable.
 *
 * Nothing in here reads the clock, a random source, or the database.
 *
 * COLOUR: raw hex is used below. DESIGN.md's colour contract governs CSS in
 * `.tsx` feature code; a PDF is a non-CSS renderer in the same category as
 * `src/lib/emails/` (email clients cannot resolve CSS custom properties, and
 * neither can PDF), so it carries literal values. Severity is still never
 * carried by colour ALONE — every dot is drawn beside its written label, per
 * DESIGN.md's "colour is never alone" rule.
 */

const PAGE_MARGIN = 48;
const FOOTER_RESERVE = 30;

/** Severity dot colours. Paired with the severity word in every use. */
const SEVERITY_HEX: Record<string, string> = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#ca8a04',
  low: '#2563eb',
};
const SEVERITY_FALLBACK_HEX = '#6b7280';

const INK = '#111827';
const INK_MUTED = '#6b7280';
const RULE_LINE = '#d1d5db';
const ROW_SHADE = '#f3f4f6';
const HEADER_SHADE = '#e5e7eb';

type Doc = PDFKit.PDFDocument;

function dash(value: string | number | undefined | null): string {
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

/** ISO timestamp trimmed to minutes, in UTC. No locale, no timezone drift. */
function ts(value: string | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

function contentWidth(doc: Doc): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function bottomLimit(doc: Doc): number {
  return doc.page.height - doc.page.margins.bottom - FOOTER_RESERVE;
}

/** Start a new page when `height` would not fit above the footer band. */
function ensureSpace(doc: Doc, height: number): void {
  if (doc.y + height > bottomLimit(doc)) doc.addPage();
}

function sectionHeading(doc: Doc, title: string): void {
  ensureSpace(doc, 34);
  doc.moveDown(0.8);
  const left = doc.page.margins.left;
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(INK)
    .text(title.toUpperCase(), left, doc.y, {
      width: contentWidth(doc),
      characterSpacing: 0.6,
      lineBreak: false,
    });
  doc.x = left;
  const y = doc.y + 3;
  doc
    .strokeColor(RULE_LINE)
    .lineWidth(0.75)
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .stroke();
  doc.y = y + 6;
}

/** A two-column label/value block. Wraps and page-breaks per row. */
function keyValues(doc: Doc, rows: Array<[string, string]>): void {
  const width = contentWidth(doc);
  const labelWidth = 150;
  const valueWidth = width - labelWidth - 8;

  for (const [label, value] of rows) {
    doc.font('Helvetica').fontSize(9);
    const height = Math.max(
      doc.heightOfString(label, { width: labelWidth }),
      doc.heightOfString(value, { width: valueWidth })
    );
    ensureSpace(doc, height + 4);

    const y = doc.y;
    doc.fillColor(INK_MUTED).text(label, doc.page.margins.left, y, { width: labelWidth });
    doc
      .fillColor(INK)
      .text(value, doc.page.margins.left + labelWidth + 8, y, { width: valueWidth });
    doc.y = y + height + 4;
  }
}

interface TableColumn {
  header: string;
  width: number;
  align?: 'left' | 'right';
}

/**
 * A shaded table that page-breaks cleanly: the header row is re-drawn at the
 * top of every page it continues onto, so a table split across pages is still
 * readable rather than a run of unlabelled numbers.
 */
function table(doc: Doc, columns: TableColumn[], rows: string[][]): void {
  const left = doc.page.margins.left;
  const total = columns.reduce((sum, c) => sum + c.width, 0);

  const drawHeader = () => {
    const height = 16;
    ensureSpace(doc, height + 12);
    const y = doc.y;
    doc.rect(left, y, total, height).fill(HEADER_SHADE);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK);
    let x = left;
    for (const col of columns) {
      doc.text(col.header, x + 4, y + 4.5, {
        width: col.width - 8,
        align: col.align ?? 'left',
        lineBreak: false,
      });
      x += col.width;
    }
    doc.x = left;
    doc.y = y + height;
  };

  if (rows.length === 0) {
    drawHeader();
    ensureSpace(doc, 16);
    const y = doc.y;
    doc.font('Helvetica').fontSize(8).fillColor(INK_MUTED).text('None recorded', left + 4, y + 4);
    doc.x = left;
    doc.y = y + 16;
    return;
  }

  drawHeader();

  rows.forEach((row, index) => {
    doc.font('Helvetica').fontSize(8);
    const cellHeight = Math.max(
      ...row.map((cell, i) => doc.heightOfString(cell, { width: columns[i].width - 8 }))
    );
    const height = Math.max(14, cellHeight + 5);

    if (doc.y + height > bottomLimit(doc)) {
      doc.addPage();
      drawHeader();
    }

    const y = doc.y;
    if (index % 2 === 0) doc.rect(left, y, total, height).fill(ROW_SHADE);

    doc.font('Helvetica').fontSize(8).fillColor(INK);
    let x = left;
    row.forEach((cell, i) => {
      doc.text(cell, x + 4, y + 3, {
        width: columns[i].width - 8,
        align: columns[i].align ?? 'left',
      });
      x += columns[i].width;
    });
    doc.x = left;
    doc.y = y + height;
  });
}

/** Severity: a coloured dot AND the word. Never the dot alone. */
function severityLine(doc: Doc, severity: string): void {
  ensureSpace(doc, 16);
  const y = doc.y;
  const left = doc.page.margins.left;
  const hex = SEVERITY_HEX[severity] ?? SEVERITY_FALLBACK_HEX;

  doc.font('Helvetica').fontSize(9).fillColor(INK_MUTED).text('Severity', left, y, { width: 150 });
  doc.circle(left + 162, y + 4.5, 3.2).fill(hex);
  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(9)
    .text(severity.toUpperCase(), left + 170, y, { width: contentWidth(doc) - 170 });
  doc.font('Helvetica');
  doc.x = left;
  doc.y = y + 14;
}

function bullets(doc: Doc, lines: string[], emptyText: string): void {
  const width = contentWidth(doc) - 12;
  if (lines.length === 0) {
    ensureSpace(doc, 14);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(INK_MUTED)
      .text(emptyText, doc.page.margins.left, doc.y, { width: contentWidth(doc) });
    return;
  }
  for (const line of lines) {
    doc.font('Helvetica').fontSize(9);
    const height = doc.heightOfString(line, { width });
    ensureSpace(doc, height + 4);
    const y = doc.y;
    doc.fillColor(INK_MUTED).text('•', doc.page.margins.left, y, { width: 10 });
    doc.fillColor(INK).text(line, doc.page.margins.left + 12, y, { width });
    doc.y = y + height + 3;
  }
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export function renderViolationReportPdf(report: ViolationReport): Promise<Buffer> {
  const contentHash = contentHashOf(report);
  const created = new Date(report.generatedAt);
  const stamp = Number.isNaN(created.getTime()) ? new Date(0) : created;

  const doc: Doc = new PDFDocument({
    size: 'A4',
    margin: PAGE_MARGIN,
    // Uncompressed streams: deterministic bytes, and the text is inspectable.
    compress: false,
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: `Violation report ${report.reportId}`,
      Author: report.header.firmName,
      Subject: `${report.rule.label} — account ${report.header.login}`,
      // Pinned, or pdfkit stamps the wall clock and the /ID digest with it.
      CreationDate: stamp,
      ModDate: stamp,
    },
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  writeBody(doc, report);
  writeFooters(doc, report, contentHash);
  doc.end();

  return done;
}

function writeBody(doc: Doc, report: ViolationReport): void {
  const width = contentWidth(doc);

  // ── Title block ───────────────────────────────────────────────────────────
  const left = doc.page.margins.left;
  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor(INK)
    .text('Violation report', left, doc.y, { width });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(9).fillColor(INK_MUTED);
  doc.text(report.header.firmName, left, doc.y, { width });
  doc.text(
    `Account ${report.header.login}${report.header.traderName ? ` · ${report.header.traderName}` : ''}`,
    left,
    doc.y,
    { width }
  );
  doc.text(`Report ${report.reportId}`, left, doc.y, { width });
  doc.text(`Generated ${ts(report.generatedAt)} by ${report.generatedBy}`, left, doc.y, { width });
  doc.moveDown(0.4);

  // ── The rule ──────────────────────────────────────────────────────────────
  sectionHeading(doc, 'The rule');
  keyValues(doc, [
    ['Rule', `${report.rule.label} (${report.rule.id})`],
    ['Limit as written', report.rule.limitAsWritten],
    [
      'Source',
      report.rule.source === 'rule_pack'
        ? `Rule pack${report.rule.pack ? ` "${report.rule.pack.name}" v${report.rule.pack.version}` : ''}`
        : 'Legacy detection engine',
    ],
    ...(report.rule.pack
      ? ([
          ['Pack content hash', report.rule.pack.contentHash || '—'],
          ['Pack id', report.rule.pack.id],
        ] as Array<[string, string]>)
      : []),
    ['Action', dash(report.rule.action)],
  ]);

  // ── What happened ─────────────────────────────────────────────────────────
  sectionHeading(doc, 'What happened');
  keyValues(doc, [['Observed', report.whatHappened.observed]]);
  severityLine(doc, report.whatHappened.severity);
  keyValues(doc, [
    ['Detected at', ts(report.whatHappened.detectedAt)],
    ['Status', report.whatHappened.status],
    ['Session day', dash(report.whatHappened.sessionDay)],
    [
      'Exceeded limit by',
      report.whatHappened.exceededBy === undefined ? '—' : usd(report.whatHappened.exceededBy),
    ],
  ]);

  // ── The arithmetic ────────────────────────────────────────────────────────
  sectionHeading(doc, 'The arithmetic');
  table(
    doc,
    [
      { header: 'Line', width: 170 },
      { header: 'Expression', width: 209 },
      { header: 'Value', width: 120, align: 'right' },
    ],
    report.arithmetic.map((a) => [a.label, a.expression ?? '', a.value])
  );

  // ── Timeline ──────────────────────────────────────────────────────────────
  sectionHeading(doc, 'Timeline');
  table(
    doc,
    [
      { header: 'When (UTC)', width: 108 },
      { header: 'Kind', width: 78 },
      { header: 'What', width: 213 },
      { header: 'Actor', width: 100 },
    ],
    report.timeline.map((t) => [ts(t.at), t.kind, t.summary, t.actor ?? ''])
  );

  // ── The trades ────────────────────────────────────────────────────────────
  sectionHeading(doc, 'The trades');
  table(
    doc,
    [
      { header: 'Trade', width: 84 },
      { header: 'Symbol', width: 54 },
      { header: 'Side', width: 36 },
      { header: 'Size', width: 40, align: 'right' },
      { header: 'Opened (UTC)', width: 90 },
      { header: 'Closed (UTC)', width: 90 },
      { header: 'P&L', width: 60, align: 'right' },
      { header: 'Cited', width: 45 },
    ],
    report.trades.map((t) => [
      t.id,
      t.symbol,
      t.side,
      String(t.volume),
      ts(t.openedAt),
      t.closedAt ? ts(t.closedAt) : '—',
      t.pnl === undefined ? '—' : usd(t.pnl),
      t.flagged ? 'yes' : 'no',
    ])
  );

  // ── Account at detection ──────────────────────────────────────────────────
  sectionHeading(doc, 'Account at detection');
  const snap = report.accountSnapshot;
  keyValues(doc, [
    ['Balance', usd(snap.balance)],
    ['Equity', usd(snap.equity)],
    ['Starting balance', usd(snap.startingBalance)],
    ['Starting day balance', snap.startingDayBalance === undefined ? '—' : usd(snap.startingDayBalance)],
    ['Starting day equity', snap.startingDayEquity === undefined ? '—' : usd(snap.startingDayEquity)],
    ['Drawdown floor', snap.drawdownFloor === undefined ? '—' : usd(snap.drawdownFloor)],
    ['Net transfers', snap.netTransfers === undefined ? '—' : usd(snap.netTransfers)],
    ['Phase', dash(report.header.phase)],
    ['Plan', dash(report.header.planName)],
    ['Asset class', dash(report.header.assetClass)],
  ]);

  // ── Action taken ──────────────────────────────────────────────────────────
  sectionHeading(doc, 'Action taken');
  keyValues(doc, [
    ['Queue status', dash(report.action.queueStatus)],
    ['Decision', dash(report.action.decision)],
    ['Approver', dash(report.action.approver)],
    ['Decided at', ts(report.action.decidedAt)],
    ['Executed at', ts(report.action.executedAt)],
    ['Deduction', report.action.deduction ? usd(report.action.deduction.amount) : '—'],
    [
      'Balance before / after',
      report.action.deduction && report.action.deduction.preBalance !== undefined
        ? `${usd(report.action.deduction.preBalance)} → ${usd(report.action.deduction.postBalance ?? 0)}`
        : '—',
    ],
    ['Executed by', dash(report.action.deduction?.executedBy)],
  ]);

  // ── History ───────────────────────────────────────────────────────────────
  sectionHeading(doc, 'History');
  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor(INK_MUTED)
    .text('Prior violations on this account', doc.page.margins.left, doc.y, { width });
  doc.y += 2;
  table(
    doc,
    [
      { header: 'Detected (UTC)', width: 110 },
      { header: 'Rule', width: 180 },
      { header: 'Status', width: 100 },
      { header: 'Violation id', width: 109 },
    ],
    report.history.priorViolations.map((p) => [ts(p.detectedAt), p.ruleLabel, p.status, p.id])
  );
  doc.moveDown(0.4);
  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor(INK_MUTED)
    .text('Disputes', doc.page.margins.left, doc.y, { width });
  doc.y += 2;
  table(
    doc,
    [
      { header: 'Opened (UTC)', width: 110 },
      { header: 'Status', width: 90 },
      { header: 'Resolution', width: 189 },
      { header: 'Dispute id', width: 110 },
    ],
    report.history.disputes.map((d) => [ts(d.openedAt), d.status, d.resolution ?? '—', d.id])
  );

  // ── Provenance ────────────────────────────────────────────────────────────
  sectionHeading(doc, 'Provenance and data fidelity');
  keyValues(doc, [
    ['Audit chain entry', dash(report.provenance.auditHash)],
    ['Evidence pack', dash(report.provenance.evidencePackId)],
    [
      'Source rows found',
      [
        'violation',
        report.provenance.sourceRows.breachDecision ? 'breach decision' : null,
        report.provenance.sourceRows.evidencePack ? 'evidence pack' : null,
        report.provenance.sourceRows.enforcementQueue ? 'enforcement queue' : null,
      ]
        .filter(Boolean)
        .join(', '),
    ],
    ['Report schema', `v${report.schemaVersion}`],
  ]);
  doc.moveDown(0.3);
  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor(INK_MUTED)
    .text('What this report cannot claim', doc.page.margins.left, doc.y, { width });
  doc.y += 3;
  bullets(doc, report.provenance.dataFidelity, 'No fidelity limits recorded.');

  if (report.provenance.generatedNarrative) {
    doc.moveDown(0.5);
    doc
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .fillColor(INK_MUTED)
      .text('Generated narrative', doc.page.margins.left, doc.y, { width });
    doc.y += 3;
    doc
      .font('Helvetica-Oblique')
      .fontSize(8)
      .fillColor(INK_MUTED)
      .text(report.provenance.generatedNarrative.disclaimer, { width });
    doc.y += 3;
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(report.provenance.generatedNarrative.text, { width });
  }
}

/**
 * Footer on every page, written in a final pass over the buffered pages so
 * "page x of y" can name a total the first pass did not yet know.
 */
function writeFooters(doc: Doc, report: ViolationReport, contentHash: string): void {
  const range = doc.bufferedPageRange();
  const label = `${brand.productName} · report ${report.reportId} · sha256 ${contentHash.slice(0, 12)}`;

  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);

    // pdfkit starts a new page when text would cross the bottom margin, which
    // would make the footer pass generate pages forever. Drop the margin for
    // the duration of the write.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = doc.page.height - PAGE_MARGIN + 6;
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor(INK_MUTED)
      .text(`${label} · page ${i - range.start + 1} of ${range.count}`, PAGE_MARGIN, y, {
        width: doc.page.width - PAGE_MARGIN * 2,
        align: 'left',
        lineBreak: false,
      });

    doc.page.margins.bottom = savedBottom;
  }

  doc.flushPages();
}
