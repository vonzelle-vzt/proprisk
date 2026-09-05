import { beforeEach, describe, expect, it, vi } from 'vitest';

// Live mode: the guarded, persisted path is the one under test.
vi.mock('@/lib/demo', () => ({ DEMO_MODE: false }));

const requireRiskUserMock = vi.fn();
const requireRiskManagerMock = vi.fn();
vi.mock('@/lib/auth/guards', () => ({
  requireRiskUser: () => requireRiskUserMock(),
  requireRiskManager: () => requireRiskManagerMock(),
}));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/rate-limit/limiter', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  rateLimitResponse: () => Response.json({ error: 'Too many requests' }, { status: 429 }),
}));

const createClientMock = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => createClientMock(),
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
import { GET, POST } from './route';
import type { ViolationReport } from '@/lib/reports/violation';

const TENANT = '11111111-1111-1111-1111-111111111111';
const VIOLATION_ID = '22222222-2222-2222-2222-222222222222';

const ANALYST = {
  ok: true as const,
  user: { id: 'user-1', email: 'ana@firm.com' },
  role: 'risk_analyst',
  actor: 'ana@firm.com',
  tenantId: TENANT,
};

const MANAGER = { ...ANALYST, role: 'risk_manager', actor: 'dana@firm.com' };

const REPORT: ViolationReport = {
  schemaVersion: 1,
  reportId: 'report-1',
  generatedAt: '2026-03-03T09:00:00.000Z',
  generatedBy: 'dana@firm.com',
  header: { firmName: 'Northwind Prop', accountId: 'acct-1', login: '1001' },
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

const RECORD = {
  id: 'row-1',
  tenantId: TENANT,
  violationId: VIOLATION_ID,
  accountId: 'acct-1',
  subjectType: 'violation' as const,
  report: REPORT,
  contentHash: 'hash-1',
  generatedBy: 'dana@firm.com',
  generatedAt: '2026-03-03T09:00:00.000Z',
  auditHash: 'audit-1',
};

function get(format?: string, id = VIOLATION_ID) {
  const url = `http://localhost/api/violations/${id}/report${format ? `?format=${format}` : ''}`;
  return GET(new NextRequest(url), { params: { id } });
}

function post(id = VIOLATION_ID) {
  const url = `http://localhost/api/violations/${id}/report`;
  return POST(new NextRequest(url, { method: 'POST' }), { params: { id } });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRiskUserMock.mockResolvedValue(ANALYST);
  requireRiskManagerMock.mockResolvedValue(MANAGER);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  createClientMock.mockReturnValue({ from: () => ({}) });
  getLatestViolationReportMock.mockResolvedValue(RECORD);
  buildViolationReportMock.mockResolvedValue({ record: RECORD, unchanged: false });
});

describe('GET /api/violations/[id]/report — authorization', () => {
  it('is 401 for an unauthenticated caller, and never touches the database', async () => {
    requireRiskUserMock.mockResolvedValue({
      ok: false,
      response: Response.json({ error: 'Unauthorized' }, { status: 401 }),
    });

    const res = await get();

    expect(res.status).toBe(401);
    expect(createClientMock).not.toHaveBeenCalled();
    expect(buildViolationReportMock).not.toHaveBeenCalled();
  });

  it('refuses before the rate limiter is consulted', async () => {
    requireRiskUserMock.mockResolvedValue({
      ok: false,
      response: Response.json({ error: 'Forbidden' }, { status: 403 }),
    });

    await get();

    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it('is 429 when the limiter refuses', async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, remaining: 0, reset_at: Date.now() });
    const res = await get();
    expect(res.status).toBe(429);
    expect(buildViolationReportMock).not.toHaveBeenCalled();
  });

  it('rate-limits on the documented key and budget', async () => {
    await get();
    expect(checkRateLimitMock).toHaveBeenCalledWith('violation-report', {
      windowMs: 60_000,
      maxRequests: 30,
    });
  });
});

describe('GET /api/violations/[id]/report — validation', () => {
  it('is 400 for a non-uuid violation id', async () => {
    const res = await get(undefined, 'not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('is 400 for an unsupported format', async () => {
    const res = await get('docx');
    expect(res.status).toBe(400);
    expect(requireRiskUserMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/violations/[id]/report — responses', () => {
  it('returns JSON by default, uncached', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect((await res.json()).data.reportId).toBe('report-1');
  });

  it('returns a downloadable PDF for format=pdf', async () => {
    const res = await get('pdf');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="proprisk-violation-${VIOLATION_ID}.pdf"`
    );
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('returns a downloadable CSV for format=csv', async () => {
    const res = await get('csv');
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="proprisk-violation-${VIOLATION_ID}.csv"`
    );
    expect(await res.text()).toContain('Summary');
  });

  it('serves the persisted report and does NOT rebuild when one exists', async () => {
    await get();
    expect(getLatestViolationReportMock).toHaveBeenCalled();
    expect(buildViolationReportMock).not.toHaveBeenCalled();
  });

  it('builds on first ask, naming the signed-in human as the generator', async () => {
    getLatestViolationReportMock.mockResolvedValue(null);
    await get();
    expect(buildViolationReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, violationId: VIOLATION_ID, actor: 'ana@firm.com' })
    );
  });

  it('is 404 when the violation is not visible to this tenant', async () => {
    const { ViolationNotFoundError } = await import('@/lib/reports/violation');
    getLatestViolationReportMock.mockResolvedValue(null);
    buildViolationReportMock.mockRejectedValue(new ViolationNotFoundError(VIOLATION_ID));

    const res = await get();
    expect(res.status).toBe(404);
  });

  it('is 500 — not a silent empty report — when the database fails', async () => {
    getLatestViolationReportMock.mockRejectedValue(new Error('connection reset'));
    const res = await get();
    expect(res.status).toBe(500);
  });
});

describe('POST /api/violations/[id]/report — regenerate', () => {
  it('requires a risk manager', async () => {
    requireRiskManagerMock.mockResolvedValue({
      ok: false,
      response: Response.json({ error: 'Forbidden' }, { status: 403 }),
    });

    const res = await post();

    expect(res.status).toBe(403);
    expect(buildViolationReportMock).not.toHaveBeenCalled();
  });

  it('rebuilds and reports whether anything actually changed', async () => {
    buildViolationReportMock.mockResolvedValue({ record: RECORD, unchanged: true });
    const res = await post();
    const payload = await res.json();

    expect(res.status).toBe(201);
    expect(payload.unchanged).toBe(true);
    expect(payload.data.reportId).toBe('report-1');
    // A rebuild must not short-circuit on the existing row.
    expect(getLatestViolationReportMock).not.toHaveBeenCalled();
  });

  it('names the approving human, not a system constant', async () => {
    await post();
    expect(buildViolationReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'dana@firm.com' })
    );
  });
});
