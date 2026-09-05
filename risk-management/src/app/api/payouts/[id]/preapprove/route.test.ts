import { beforeEach, describe, expect, it, vi } from 'vitest';

// Live mode (DEMO_MODE=false) so the guarded provider/persistence path runs.
vi.mock('@/lib/demo', () => ({ DEMO_MODE: false }));

const preApprovePayoutMock = vi.fn();
const approvePayoutMock = vi.fn();
const rejectPayoutMock = vi.fn();
const savePayoutSnapshotMock = vi.fn();
const checkRateLimitMock = vi.fn();
const composeDecisionRationaleMock = vi.fn();
const polishExplanationMock = vi.fn();
const logAuditEventMock = vi.fn();
const createAdminClientMock = vi.fn();
const invalidateMock = vi.fn();

vi.mock('@/lib/platform/client', () => ({
  preApprovePayout: (...args: unknown[]) => preApprovePayoutMock(...args),
  approvePayout: (...args: unknown[]) => approvePayoutMock(...args),
  rejectPayout: (...args: unknown[]) => rejectPayoutMock(...args),
}));

vi.mock('@/lib/payouts/snapshot', () => ({
  savePayoutSnapshot: (...args: unknown[]) => savePayoutSnapshotMock(...args),
}));

vi.mock('@/lib/rate-limit/limiter', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  rateLimitResponse: () => Response.json({ error: 'rate limited' }, { status: 429 }),
}));

vi.mock('@/lib/payouts/decision', () => ({
  composeDecisionRationale: (...args: unknown[]) => composeDecisionRationaleMock(...args),
  polishExplanation: (...args: unknown[]) => polishExplanationMock(...args),
}));

vi.mock('@/lib/audit/chain', () => ({
  logAuditEvent: (...args: unknown[]) => logAuditEventMock(...args),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => createAdminClientMock(),
}));

vi.mock('@/lib/logging/logger', () => ({
  logError: vi.fn(),
}));

vi.mock('@/lib/cache/provider-cache', () => ({
  invalidate: (...args: unknown[]) => invalidateMock(...args),
}));

const requireRiskManagerMock = vi.fn();
vi.mock('@/lib/auth/guards', () => ({
  requireRiskManager: () => requireRiskManagerMock(),
}));

import { POST } from './route';

const MANAGER = {
  ok: true as const,
  user: { id: 'user-77', email: 'dana@firm.com' },
  role: 'risk_manager',
  actor: 'dana@firm.com',
  tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
};

const RECORD = { _id: 'payout-1', accountId: 'acc-9', amount: 5000 };

function post(body: unknown, id = 'payout-1') {
  const request = new Request('http://localhost/api/payouts/payout-1/preapprove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as any;
  return POST(request, { params: Promise.resolve({ id }) });
}

describe('POST /api/payouts/[id]/preapprove — final decisions (live)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireRiskManagerMock.mockResolvedValue(MANAGER);
    checkRateLimitMock.mockResolvedValue({ allowed: true });
    savePayoutSnapshotMock.mockResolvedValue({ id: 'snap-1' });
    composeDecisionRationaleMock.mockReturnValue({ rationale: { citedRules: [] }, explanation: 'raw' });
    polishExplanationMock.mockResolvedValue('polished explanation');
    logAuditEventMock.mockResolvedValue('audit-hash');
    invalidateMock.mockResolvedValue(undefined);
    createAdminClientMock.mockReturnValue({
      from: () => ({ insert: async () => ({ error: null }) }),
    });
  });

  it('finalizes on the provider BEFORE writing the snapshot, and returns success', async () => {
    const order: string[] = [];
    approvePayoutMock.mockImplementation(async () => {
      order.push('provider');
    });
    savePayoutSnapshotMock.mockImplementation(async () => {
      order.push('snapshot');
      return { id: 'snap-1' };
    });

    const res = await post({ action: 'approve', record: RECORD, note: 'ok' });
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.action).toBe('approved');
    // Provider call must happen strictly before the snapshot persist.
    expect(order).toEqual(['provider', 'snapshot']);
    expect(approvePayoutMock).toHaveBeenCalledTimes(1);
    expect(savePayoutSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it('returns 502 and writes NO snapshot/decision when the provider call fails', async () => {
    approvePayoutMock.mockRejectedValue(new Error('provider down'));

    const res = await post({ action: 'approve', record: RECORD });
    const payload = await res.json();

    expect(res.status).toBe(502);
    expect(payload.error).toBe('Trading platform call failed');
    // No phantom snapshot / decision row on provider failure.
    expect(savePayoutSnapshotMock).not.toHaveBeenCalled();
    expect(logAuditEventMock).not.toHaveBeenCalled();
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it('returns 502 for a failed reject as well, with no snapshot', async () => {
    rejectPayoutMock.mockRejectedValue(new Error('provider down'));

    const res = await post({ action: 'reject', record: RECORD });

    expect(res.status).toBe(502);
    expect(savePayoutSnapshotMock).not.toHaveBeenCalled();
  });

  it('rejects a final decision with no record (400) and never touches the provider', async () => {
    const res = await post({ action: 'approve' });
    const payload = await res.json();

    expect(res.status).toBe(400);
    expect(payload.error).toBe('record required for final decisions');
    expect(approvePayoutMock).not.toHaveBeenCalled();
    expect(savePayoutSnapshotMock).not.toHaveBeenCalled();
  });

  it('still allows preapprove without a record (lenient path)', async () => {
    preApprovePayoutMock.mockResolvedValue(undefined);

    const res = await post({ action: 'preapprove', status: 1 });
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.preApprovalStatus).toBe(1);
    expect(preApprovePayoutMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/payouts/[id]/preapprove — authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimitMock.mockResolvedValue({ allowed: true });
  });

  // Every action on this route moves money. requireRiskManager gates it, so a
  // risk_analyst must be refused before the provider is ever contacted.
  it.each(['approve', 'reject', 'preapprove'])(
    'refuses a non-manager on action=%s and never calls the provider',
    async (action) => {
      requireRiskManagerMock.mockResolvedValue({
        ok: false,
        response: Response.json({ error: 'Forbidden: requires risk_manager or admin role' }, { status: 403 }),
      });

      const res = await post({ action, status: 1, record: RECORD });

      expect(res.status).toBe(403);
      expect(approvePayoutMock).not.toHaveBeenCalled();
      expect(rejectPayoutMock).not.toHaveBeenCalled();
      expect(preApprovePayoutMock).not.toHaveBeenCalled();
      expect(savePayoutSnapshotMock).not.toHaveBeenCalled();
    }
  );

  it('is refused before the rate limiter is consulted', async () => {
    requireRiskManagerMock.mockResolvedValue({
      ok: false,
      response: Response.json({ error: 'Forbidden' }, { status: 403 }),
    });

    await post({ action: 'approve', record: RECORD });

    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/payouts/[id]/preapprove — approver identity in the audit trail', () => {
  let insertedDecision: Record<string, unknown> | null;

  beforeEach(() => {
    vi.clearAllMocks();
    insertedDecision = null;
    requireRiskManagerMock.mockResolvedValue(MANAGER);
    checkRateLimitMock.mockResolvedValue({ allowed: true });
    savePayoutSnapshotMock.mockResolvedValue({ id: 'snap-1' });
    composeDecisionRationaleMock.mockReturnValue({ rationale: { citedRules: [] }, explanation: 'raw' });
    polishExplanationMock.mockResolvedValue('polished explanation');
    logAuditEventMock.mockResolvedValue('audit-hash');
    invalidateMock.mockResolvedValue(undefined);
    approvePayoutMock.mockResolvedValue(undefined);
    rejectPayoutMock.mockResolvedValue(undefined);
    createAdminClientMock.mockReturnValue({
      from: () => ({
        // tenantDb().insert() always stamps tenant_id and wraps the payload
        // in an array (single-row or many), so the row landing here is
        // `[row]` — unwrap it to keep the assertions below about the row
        // itself, not the batch shape.
        insert: async (rows: Record<string, unknown>[]) => {
          insertedDecision = rows[0];
          return { error: null };
        },
      }),
    });
  });

  // A payout record that cannot name its approver is not evidence. Every
  // persistence sink must carry the real human, not a constant.
  it('records the approving human — not a system constant — in every sink', async () => {
    await post({ action: 'approve', record: RECORD, note: 'ok' });

    expect(approvePayoutMock).toHaveBeenCalledWith('payout-1', 'dana@firm.com', 'ok', MANAGER.tenantId);
    expect(savePayoutSnapshotMock).toHaveBeenCalledWith(RECORD, 'approved', 'dana@firm.com', 'ok');
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ performed_by: 'dana@firm.com' })
    );
    expect(insertedDecision).toMatchObject({ actor: 'dana@firm.com' });
  });

  it('carries the immutable user id and role alongside the email', async () => {
    await post({ action: 'approve', record: RECORD });

    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ actor_user_id: 'user-77', actor_role: 'risk_manager' }),
      })
    );
  });

  it('records the rejecting human on a reject too', async () => {
    await post({ action: 'reject', record: RECORD });

    expect(rejectPayoutMock).toHaveBeenCalledWith(
      'payout-1',
      'Rejected via Risk Management',
      'dana@firm.com',
      MANAGER.tenantId
    );
    expect(insertedDecision).toMatchObject({ actor: 'dana@firm.com', decision: 'reject' });
  });

  it('falls back to the user id when the account has no email', async () => {
    requireRiskManagerMock.mockResolvedValue({
      ...MANAGER,
      user: { id: 'user-77', email: undefined },
      actor: 'user-77',
    });

    await post({ action: 'approve', record: RECORD });

    expect(approvePayoutMock).toHaveBeenCalledWith('payout-1', 'user-77', '', MANAGER.tenantId);
  });
});
