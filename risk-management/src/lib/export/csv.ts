import { stringify } from 'csv-stringify/sync';

/**
 * A single CSV column: a header label plus a function that extracts the
 * cell value for a given row. Keep `value` pure — it runs once per row.
 */
export type CsvColumn<T> = {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
};

/** UTF-8 byte-order mark so Excel opens accented characters correctly. */
const BOM = '﻿';

function toCell(v: string | number | boolean | null | undefined): string | number {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v;
}

/**
 * Build an RFC 4180 CSV string (with a leading UTF-8 BOM) from rows and
 * column definitions. Fields containing a comma, quote, or CR/LF are
 * quoted and embedded quotes are doubled, per RFC 4180. Uses '\n' as the
 * record delimiter.
 */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const header = columns.map((c) => c.header);
  const body = rows.map((row) => columns.map((c) => toCell(c.value(row))));

  const csv = stringify([header, ...body], { record_delimiter: '\n' });
  return BOM + csv;
}

/**
 * Build a CSV with multiple titled sections, each rendered as a single
 * title row followed by its data rows, with a blank line between
 * sections. Rows are already string[][] — no column mapping is applied.
 */
export function toCsvSections(sections: Array<{ title: string; rows: string[][] }>): string {
  const blocks = sections.map(({ title, rows }) => stringify([[title], ...rows], { record_delimiter: '\n' }));
  return BOM + blocks.join('\n');
}

function slug(base: string): string {
  return base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `${slug(base)}-${yyyy-mm-dd}.csv`, e.g. `csvFilename('Deductions')` -> `deductions-2026-09-05.csv`. */
export function csvFilename(base: string, when: Date = new Date()): string {
  const date = `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`;
  return `${slug(base)}-${date}.csv`;
}

/**
 * Client-only: trigger a browser download of `csv` as `filename` via a
 * synthetic anchor click. No-op on the server.
 */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof window === 'undefined') return;

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Server-only (but framework-free): build a `Response` that serves `csv`
 * as a downloadable attachment named `filename`.
 */
export function csvResponse(filename: string, csv: string): Response {
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
