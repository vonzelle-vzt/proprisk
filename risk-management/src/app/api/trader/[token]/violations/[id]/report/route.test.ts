import { beforeEach, describe, expect, it, vi } from 'vitest';

// The trader surface must behave as it does in production, not in demo (where
// it fails closed with a 404 — asserted separately at the bottom).
vi.mock('@/lib/demo', () => ({ DEMO_MODE: false }));

const verifyTraderTokenMock = vi.fn();
vi.mock('@/lib/trader/tokens', () => ({
  verifyTraderToken: (...args: unknown[]) => verifyTraderTokenMock(...args),
}));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/rate-limit/limiter', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  rateLimitResponse: () => Response.json({ error: 'Too many requests' }, { status: 429 }),
}));

const tenantDbMock = vi.fn();
vi.mock('@/lib/db/tenant-scoped', () => ({
  tenantDb: (...args: unknown[]) => tenantDbMock(...args),
}));

vi.mock('@/lib/logging/logger', () => ({ logError: vi.fn() }));

const getLatestViolationReportMock = vi.fn();
const buildViolationReportMock = vi.fn();

vi.mock('@/lib/reports/violation', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reports/violation')>(
    '@/lib/reports/violation'
  );
  return {
    ...actual,
    getLatestViolationReport: (...args: unknown[]) => getLatestViolationReportMock(...args),
    buildViolationReport: (...args: unknown[]) => buildViolationReportMock(...args),
  };
});

import { NextRequest } from 'next/server';
import { GET } from './route';
import type { ViolationReport, ViolationReportRecord } from '@/lib/reports/violation';

const TENANT = '11111111-1111-1111-1111-111111111111';
const VIOLATION_ID = '22222222-2222-2222-2222-222222222222';
const ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
const TOKEN = 'a'.repeat(64);

const VERIFIED = { tokenId: 'token-row-1', tenantId: TENANT, accountId: ACCOUNT_ID };

const REPORT: ViolationReport = {
  schemaVersion: 1,
  reportId: 'report-1',
  generatedAt: '2026-03-03T09:00:00.000Z',
  generatedBy: 'trader_link:token-row-1',
  header: { firmName: 'Northwind Prop', accountId: ACCOUNT_ID, login: '1001' },
  rule: { id: 'daily_loss', label: 'Daily Loss Limit', limitAsWritten: 'L', source: 'rule_pack' },
  whatHappened: {
    observed: 'o',
    severity: 'critical',
    detectedAt: '2026-03-02T21:05:00.000Z',
    status: 'detected',
  },
  arithmetic: [],
  timeline: [],
  trades: [],
  accountSnapshot: { balance: 0, equity: 0, startingBalance: 100000 },
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
};

const RECORD: ViolationReportRecord = {
  id: 'row-1',
  tenantId: TENANT,
  violationId: VIOLATION_ID,
  accountId: ACCOUNT_ID,
  subjectType: 'violation',
  report: REPORT,
  contentHash: 'hash-1',
  generatedBy: 'trader_link:token-row-1',
  generatedAt: '2026-03-03T09:00:00.000Z',
  auditHash: null,
};

/** Records the filters applied, so ownership scoping can be asserted. */
function stubDb(row: Record<string, unknown> | null, seen: Array<[string, unknown]>) {
  const builder: Record<string, unknown> = {};
  builder.eq = (col: string, val: unknown) => {
    seen.push([col, val]);
    return builder;
  };
  for (const method of ['select', 'order', 'limit', 'neq', 'in', 'gte', 'lt']) {
    builder[method] = () => builder;
  }
  builder.maybeSingle = () => Promise.resolve({ data: row, error: null });
  (builder as { then: unknown }).then = (ok: (v: unknown) => unknown) =>
    Promise.resolve({ data: row ? [row] : [], error: null }).then(ok);
  return { tenantId: TENANT, from: () => builder, insert: () => builder, update: () => builder };
}

function get(format?: string, id = VIOLATION_ID, token = TOKEN) {
  const url = `http://localhost/api/trader/${token}/violations/${id}/report${format ? `?format=${format}` : ''}`;
  return GET(new NextRequest(url), { params: { token, id } });
}

let filters: Array<[string, unknown]>;

beforeEach(() => {
  vi.clearAllMocks();
  filters = [];
  verifyTraderTokenMock.mockResolvedValue(VERIFIED);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  tenantDbMock.mockImplementation(() => stubDb({ id: VIOLATION_ID, account_id: ACCOUNT_ID }, filters));
  getLatestViolationReportMock.mockResolvedValue(RECORD);
  buildViolationReportMock.mockResolvedValue({ record: RECORD, unchanged: false });
});

describe('GET /api/trader/[token]/violations/[id]/report — the token is the whole boundary', () => {
  it('is 404 for an invalid, expired or revoked token — and reads nothing', async () => {
    verifyTraderTokenMock.mockResolvedValue(null);

    const res = await get();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(tenantDbMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  /**
   * The load-bearing assertion: a violation belonging to someone else must be
   * indistinguishable from one that never existed. A 403 here would confirm
   * the id, turning a trader link into an enumeration oracle.
   */
  it('is 404 — never 403 — for a violation on another account', async () => {
    tenantDbMock.mockImplementation(() => stubDb(null, filters));

    const res = await get();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(getLatestViolationReportMock).not.toHaveBeenCalled();
    expect(buildViolationReportMock).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the TOKEN\'s tenant and account, not the URL', async () => {
    await get();

    expect(tenantDbMock).toHaveBeenCalledWith(TENANT, 'traderViolationReport');
    expect(filters).toEqual(
      expect.arrayContaining([
        ['id', VIOLATION_ID],
        ['account_id', ACCOUNT_ID],
      ])
    );
  });

  it('rate-limits per token id, not per raw token', async () => {
    await get();
    expect(checkRateLimitMock).toHaveBeenCalledWith('violation-report-trader:token-row-1', {
      windowMs: 60_000,
      maxRequests: 20,
    });
  });

  it('is 429 when the per-token limiter refuses', async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, remaining: 0, reset_at: Date.now() });
    const res = await get();
    expect(res.status).toBe(429);
  });
});

describe('GET /api/trader/[token]/violations/[id]/report — responses', () => {
  it('serves a downloadable PDF by default', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="proprisk-violation-${VIOLATION_ID}.pdf"`
    );
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('serves CSV on request', async () => {
    const res = await get('csv');
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(await res.text()).toContain('Summary');
  });

  it('rejects a format the trader surface does not offer', async () => {
    const res = await get('json');
    expect(res.status).toBe(400);
    expect(verifyTraderTokenMock).not.toHaveBeenCalled();
  });

  it('builds on first ask, attributing it to the trader link rather than a staff member', async () => {
    getLatestViolationReportMock.mockResolvedValue(null);

    await get();

    expect(buildViolationReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        violationId: VIOLATION_ID,
        actor: 'trader_link:token-row-1',
      })
    );
  });

  it('is 500 when the database fails', async () => {
    getLatestViolationReportMock.mockRejectedValue(new Error('connection reset'));
    const res = await get();
    expect(res.status).toBe(500);
  });
});

/**
 * DEMO_MODE — the route must never reach `verifyTraderToken`/Supabase here.
 * Re-imports the route module with DEMO_MODE flipped to true, since the
 * top-of-file `vi.mock('@/lib/demo', ...)` mocks it to false for every other
 * test in this file.
 */
describe('GET /api/trader/[token]/violations/[id]/report — DEMO_MODE', () => {
  const DEMO_TOKEN = 'demo';
  const DEMO_VIOLATION_ID = '100185-grid';

  async function demoGet(format?: string, id = DEMO_VIOLATION_ID, token = DEMO_TOKEN) {
    vi.resetModules();
    vi.doMock('@/lib/demo', () => ({ DEMO_MODE: true }));
    const { GET: demoGET } = await import('./route');
    const url = `http://localhost/api/trader/${token}/violations/${id}/report${format ? `?format=${format}` : ''}`;
    return demoGET(new NextRequest(url), { params: { token, id } });
  }

  it('serves the demo PDF report over the fixed demo token, never touching verifyTraderToken', async () => {
    const res = await demoGet('pdf');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="proprisk-violation-${DEMO_VIOLATION_ID}.pdf"`
    );
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(verifyTraderTokenMock).not.toHaveBeenCalled();
    expect(tenantDbMock).not.toHaveBeenCalled();
  });

  it('serves the demo CSV report on request', async () => {
    const res = await demoGet('csv');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(await res.text()).toContain('Summary');
  });

  it('is 404 for any token other than the fixed demo token', async () => {
    const res = await demoGet('pdf', DEMO_VIOLATION_ID, 'not-demo');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('is 404 for a violation id the demo account does not have', async () => {
    const res = await demoGet('pdf', 'nonexistent-id');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });
});
