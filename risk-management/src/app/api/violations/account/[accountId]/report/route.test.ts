import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/demo', () => ({ DEMO_MODE: false }));

const requireRiskUserMock = vi.fn();
vi.mock('@/lib/auth/guards', () => ({
  requireRiskUser: () => requireRiskUserMock(),
  requireRiskManager: () => requireRiskUserMock(),
}));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/rate-limit/limiter', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  rateLimitResponse: () => Response.json({ error: 'Too many requests' }, { status: 429 }),
}));

const fromMock = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => fromMock(table) }),
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
const ACCOUNT_UUID = '33333333-3333-3333-3333-333333333333';

const AUTH = {
  ok: true as const,
  user: { id: 'user-1', email: 'ana@firm.com' },
  role: 'risk_analyst',
  actor: 'ana@firm.com',
  tenantId: TENANT,
};

function reportFor(id: string, detectedAt: string): ViolationReport {
  return {
    schemaVersion: 1,
    reportId: `report-${id}`,
    generatedAt: '2026-03-03T09:00:00.000Z',
    generatedBy: 'ana@firm.com',
    header: { firmName: 'Northwind Prop', accountId: ACCOUNT_UUID, login: '1001' },
    rule: { id: 'hft', label: 'HFT', limitAsWritten: 'L', source: 'legacy_engine' },
    whatHappened: { observed: 'o', severity: 'high', detectedAt, status: 'detected' },
    arithmetic: [],
    timeline: [],
    trades: [
      {
        id: `T-${id}`,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1,
        openedAt: detectedAt,
        flagged: true,
      },
    ],
    accountSnapshot: { balance: 1, equity: 1, startingBalance: 100000 },
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
}

function recordFor(id: string, detectedAt: string): ViolationReportRecord {
  return {
    id: `row-${id}`,
    tenantId: TENANT,
    violationId: id,
    accountId: ACCOUNT_UUID,
    subjectType: 'violation',
    report: reportFor(id, detectedAt),
    contentHash: `hash-${id}`,
    generatedBy: 'ana@firm.com',
    generatedAt: '2026-03-03T09:00:00.000Z',
    auditHash: null,
  };
}

/**
 * The route reaches the request-scoped client as
 * `client.from(table).select('*').eq(...).order(...).limit(...)` (via
 * `requestScopedReportDb`), so the stub only has to be chainable and awaitable.
 */
function stubTable(rows: Record<string, unknown>[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'neq', 'in', 'gte', 'lt', 'order', 'limit']) {
    builder[method] = () => builder;
  }
  builder.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
  (builder as { then: unknown }).then = (ok: (v: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(ok);
  return builder;
}

function get(accountId: string) {
  return GET(new NextRequest(`http://localhost/api/violations/account/${accountId}/report`), {
    params: { accountId },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRiskUserMock.mockResolvedValue(AUTH);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  getLatestViolationReportMock.mockResolvedValue(null);
  buildViolationReportMock.mockImplementation(async ({ violationId }: { violationId: string }) => ({
    record: recordFor(violationId, '2026-03-02T21:05:00.000Z'),
    unchanged: false,
  }));
  fromMock.mockImplementation((table: string) => {
    if (table === 'violations') return stubTable([{ id: 'v-1' }, { id: 'v-2' }]);
    if (table === 'accounts') return stubTable([{ id: ACCOUNT_UUID, login: '1001' }]);
    return stubTable([]);
  });
});

describe('GET /api/violations/account/[accountId]/report', () => {
  it('is 401 for an unauthenticated caller and builds nothing', async () => {
    requireRiskUserMock.mockResolvedValue({
      ok: false,
      response: Response.json({ error: 'Unauthorized' }, { status: 401 }),
    });

    const res = await get(ACCOUNT_UUID);

    expect(res.status).toBe(401);
    expect(buildViolationReportMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it('is 429 when the limiter refuses', async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, remaining: 0, reset_at: Date.now() });
    const res = await get(ACCOUNT_UUID);
    expect(res.status).toBe(429);
  });

  it('serves a downloadable CSV with both sections', async () => {
    const res = await get(ACCOUNT_UUID);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="proprisk-violations-${ACCOUNT_UUID}.csv"`
    );
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toContain('Summary');
    expect(body).toContain('\nTrades\n');
    expect(body).toContain('violation_id');
    expect(body).toContain('v-1');
    expect(body).toContain('v-2');
  });

  /**
   * The counts are the point: a job that says "exported" without saying what
   * it actually persisted is the silent-success shape this codebase keeps
   * producing (see 00024_morning_reports.sql).
   */
  it('reports how many reports it BUILT versus reused', async () => {
    getLatestViolationReportMock.mockImplementation(async (_t: string, id: string) =>
      id === 'v-1' ? recordFor('v-1', '2026-03-02T21:05:00.000Z') : null
    );

    const res = await get(ACCOUNT_UUID);

    expect(res.headers.get('X-Reports-Built')).toBe('1');
    expect(res.headers.get('X-Reports-Reused')).toBe('1');
    expect(buildViolationReportMock).toHaveBeenCalledTimes(1);
    expect(buildViolationReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ violationId: 'v-2' })
    );
  });

  it('counts a content-identical rebuild as reused, not built', async () => {
    buildViolationReportMock.mockImplementation(async ({ violationId }: { violationId: string }) => ({
      record: recordFor(violationId, '2026-03-02T21:05:00.000Z'),
      unchanged: true,
    }));

    const res = await get(ACCOUNT_UUID);

    expect(res.headers.get('X-Reports-Built')).toBe('0');
    expect(res.headers.get('X-Reports-Reused')).toBe('2');
  });

  it('resolves a provider login to the internal account id before querying', async () => {
    await get('1001');
    expect(fromMock).toHaveBeenCalledWith('accounts');
    expect(fromMock).toHaveBeenCalledWith('violations');
  });

  it('is 404 when the login matches no account in this tenant', async () => {
    fromMock.mockImplementation(() => stubTable([]));
    const res = await get('9999');
    expect(res.status).toBe(404);
    expect(buildViolationReportMock).not.toHaveBeenCalled();
  });

  it('exports an empty-but-valid CSV for an account with no violations', async () => {
    fromMock.mockImplementation((table: string) =>
      table === 'accounts' ? stubTable([{ id: ACCOUNT_UUID, login: '1001' }]) : stubTable([])
    );

    const res = await get(ACCOUNT_UUID);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Reports-Built')).toBe('0');
    expect(body).toContain('Summary');
    expect(body).toContain('Trades');
  });

  it('is 500 when the database fails, never a partial CSV', async () => {
    getLatestViolationReportMock.mockRejectedValue(new Error('connection reset'));
    const res = await get(ACCOUNT_UUID);
    expect(res.status).toBe(500);
  });
});
