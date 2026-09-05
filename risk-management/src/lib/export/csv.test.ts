import { describe, it, expect } from 'vitest';
import { toCsv, toCsvSections, csvFilename, csvResponse, type CsvColumn } from './csv';

const BOM = '﻿';

type Row = { name: string; note: string; amount: number; active: boolean | null; missing: undefined };

describe('toCsv', () => {
  const columns: readonly CsvColumn<Row>[] = [
    { header: 'Name', value: (r) => r.name },
    { header: 'Note', value: (r) => r.note },
    { header: 'Amount', value: (r) => r.amount },
    { header: 'Active', value: (r) => r.active },
    { header: 'Missing', value: (r) => r.missing },
  ];

  it('quotes fields containing a comma', () => {
    const rows: Row[] = [{ name: 'Doe, Jane', note: 'ok', amount: 1, active: true, missing: undefined }];
    const csv = toCsv(rows, columns);
    expect(csv).toBe(`${BOM}Name,Note,Amount,Active,Missing\n"Doe, Jane",ok,1,true,\n`);
  });

  it('quotes and doubles embedded quotes', () => {
    const rows: Row[] = [{ name: 'Jane "JJ" Doe', note: 'ok', amount: 1, active: false, missing: undefined }];
    const csv = toCsv(rows, columns);
    expect(csv).toBe(`${BOM}Name,Note,Amount,Active,Missing\n"Jane ""JJ"" Doe",ok,1,false,\n`);
  });

  it('quotes fields containing a newline', () => {
    const rows: Row[] = [{ name: 'Jane', note: 'line1\nline2', amount: 1, active: true, missing: undefined }];
    const csv = toCsv(rows, columns);
    expect(csv).toBe(`${BOM}Name,Note,Amount,Active,Missing\nJane,"line1\nline2",1,true,\n`);
  });

  it('renders null and undefined as empty strings', () => {
    const rows: Row[] = [{ name: 'Jane', note: 'ok', amount: 1, active: null, missing: undefined }];
    const csv = toCsv(rows, columns);
    expect(csv).toBe(`${BOM}Name,Note,Amount,Active,Missing\nJane,ok,1,,\n`);
  });

  it('leaves numbers unformatted', () => {
    const rows: Row[] = [{ name: 'Jane', note: 'ok', amount: 1234.5, active: true, missing: undefined }];
    const csv = toCsv(rows, columns);
    expect(csv).toBe(`${BOM}Name,Note,Amount,Active,Missing\nJane,ok,1234.5,true,\n`);
  });

  it('renders booleans as literal true/false', () => {
    const rows: Row[] = [{ name: 'Jane', note: 'ok', amount: 1, active: true, missing: undefined }];
    const csv = toCsv(rows, columns);
    expect(csv).toContain(',true,');
  });

  it('prepends exactly one UTF-8 BOM', () => {
    const csv = toCsv([], columns);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.indexOf(BOM)).toBe(0);
    expect(csv.slice(1).includes(BOM)).toBe(false);
  });

  it('handles an empty rows array (header only)', () => {
    const csv = toCsv([], columns);
    expect(csv).toBe(`${BOM}Name,Note,Amount,Active,Missing\n`);
  });
});

describe('toCsvSections', () => {
  it('renders a title row, data rows, then a blank line between sections', () => {
    const csv = toCsvSections([
      { title: 'Section One', rows: [['a', 'b'], ['c, d', 'e']] },
      { title: 'Section Two', rows: [['1', '2']] },
    ]);
    expect(csv).toBe(`${BOM}Section One\na,b\n"c, d",e\n\nSection Two\n1,2\n`);
  });

  it('prepends exactly one UTF-8 BOM', () => {
    const csv = toCsvSections([{ title: 'Only', rows: [['x']] }]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.slice(1).includes(BOM)).toBe(false);
  });
});

describe('csvFilename', () => {
  it('slugifies the base name and appends an ISO date', () => {
    const when = new Date(2026, 8, 5); // 2026-09-05 (month is 0-indexed)
    expect(csvFilename('Deductions', when)).toBe('deductions-2026-09-05.csv');
  });

  it('slugifies spaces and mixed case into underscores', () => {
    const when = new Date(2026, 0, 1);
    expect(csvFilename('Payout History', when)).toBe('payout_history-2026-01-01.csv');
  });

  it('pads single-digit months and days', () => {
    const when = new Date(2026, 2, 4);
    expect(csvFilename('risk_payouts', when)).toBe('risk_payouts-2026-03-04.csv');
  });
});

describe('csvResponse', () => {
  it('sets CSV content-type, attachment disposition, and no-store cache headers', async () => {
    const res = csvResponse('deductions-2026-09-05.csv', `${BOM}a,b\n1,2\n`);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="deductions-2026-09-05.csv"');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    // Response.text() decodes as UTF-8 and strips a leading BOM, so assert
    // on the body content rather than the raw bytes.
    expect(await res.text()).toBe('a,b\n1,2\n');
  });
});
