import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createAdminClientMock = vi.fn();

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => createAdminClientMock(),
}));

function buildSupabaseMock(opts: {
  previousHash?: string | null;
  insertError?: { message: string } | null;
  // rpc defaults to "function not found" so tests exercise the TS fallback
  // path (its hash computation is what these cases assert). Pass rpcData or a
  // non-PGRST202 rpcError to exercise the RPC path instead.
  rpcData?: string | null;
  rpcError?: { code: string; message: string } | null;
}) {
  const rpcError =
    opts.rpcError === undefined
      ? { code: 'PGRST202', message: 'Could not find the function' }
      : opts.rpcError;
  return {
    rpc: async () => {
      if (rpcError) return { data: null, error: rpcError };
      return { data: opts.rpcData ?? null, error: null };
    },
    from: (table: string) => {
      if (table !== 'audit_log') throw new Error(`Unexpected table ${table}`);
      return {
        select: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({
                data: opts.previousHash !== undefined && opts.previousHash !== null ? { entry_hash: opts.previousHash } : null,
                error: null,
              }),
            }),
          }),
        }),
        insert: (payload: Record<string, unknown>) => ({
          select: () => ({
            maybeSingle: async () => {
              if (opts.insertError) return { data: null, error: opts.insertError };
              return { data: { id: 'row-1', ...payload }, error: null };
            },
          }),
        }),
      };
    },
  };
}

describe('logAuditEvent (non-demo)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'false');
    createAdminClientMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('computes a deterministic entry_hash over prev_hash + payload at a fixed instant', async () => {
    createAdminClientMock.mockReturnValue(buildSupabaseMock({ previousHash: 'prev-hash-abc' }));
    const { logAuditEvent } = await import('./chain');

    const params = {
      action_type: 'deduction_executed' as const,
      entity_type: 'deduction',
      entity_id: 'ded-1',
      performed_by: 'system',
      details: { amount: 100, account_id: 'acc-1' },
    };

    const hash1 = await logAuditEvent(params);
    const hash2 = await logAuditEvent(params);

    expect(typeof hash1).toBe('string');
    expect(hash1).toHaveLength(64); // sha256 hex
    expect(hash1).toBe(hash2); // same inputs + same prev_hash + same frozen clock => same hash
  });

  it('produces a different hash when prev_hash differs (chaining)', async () => {
    const { logAuditEvent } = await import('./chain');
    const params = {
      action_type: 'violation_detected' as const,
      entity_type: 'violation',
      entity_id: 'v-1',
      performed_by: 'system',
      details: { type: 'hft' },
    };

    createAdminClientMock.mockReturnValue(buildSupabaseMock({ previousHash: 'GENESIS' }));
    const hashFromGenesis = await logAuditEvent(params);

    createAdminClientMock.mockReturnValue(buildSupabaseMock({ previousHash: 'some-other-hash' }));
    const hashFromOther = await logAuditEvent(params);

    expect(hashFromGenesis).not.toBe(hashFromOther);
  });

  it('produces a different hash when the payload differs but prev_hash is the same', async () => {
    const { logAuditEvent } = await import('./chain');
    createAdminClientMock.mockReturnValue(buildSupabaseMock({ previousHash: 'GENESIS' }));

    const hashA = await logAuditEvent({
      action_type: 'deduction_executed',
      entity_type: 'deduction',
      entity_id: 'ded-1',
      performed_by: 'system',
      details: { amount: 100 },
    });
    const hashB = await logAuditEvent({
      action_type: 'deduction_executed',
      entity_type: 'deduction',
      entity_id: 'ded-1',
      performed_by: 'system',
      details: { amount: 200 },
    });

    expect(hashA).not.toBe(hashB);
  });

  it('uses GENESIS as the prev_hash when no prior entry exists', async () => {
    createAdminClientMock.mockReturnValue(buildSupabaseMock({ previousHash: null }));
    const { logAuditEvent } = await import('./chain');

    const withGenesis = await logAuditEvent({
      action_type: 'cron_detect_violations',
      entity_type: 'system',
      entity_id: 'run-1',
      performed_by: 'system',
      details: {},
    });

    createAdminClientMock.mockReturnValue(buildSupabaseMock({ previousHash: 'GENESIS' }));
    const withExplicitGenesis = await logAuditEvent({
      action_type: 'cron_detect_violations',
      entity_type: 'system',
      entity_id: 'run-1',
      performed_by: 'system',
      details: {},
    });

    expect(withGenesis).toBe(withExplicitGenesis);
  });

  it('uses the append_audit_event RPC when available and returns its entry_hash', async () => {
    const rpcMock = vi.fn(async () => ({ data: 'rpc-entry-hash', error: null }));
    const fromMock = vi.fn(() => {
      throw new Error('fallback insert path should not run when the RPC succeeds');
    });
    createAdminClientMock.mockReturnValue({ rpc: rpcMock, from: fromMock });
    const { logAuditEvent } = await import('./chain');

    const result = await logAuditEvent({
      action_type: 'payout_decision',
      entity_type: 'payout',
      entity_id: 'p-1',
      performed_by: 'Risk Management System',
      details: { decision: 'approve', accountId: '100074' },
    });

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(result).toBe('rpc-entry-hash');
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('passes byte-identical canonical details to the RPC (matches the TS hash input)', async () => {
    const rpcMock = vi.fn(async () => ({ data: 'h', error: null }));
    createAdminClientMock.mockReturnValue({ rpc: rpcMock, from: vi.fn() });
    const { logAuditEvent } = await import('./chain');

    await logAuditEvent({
      action_type: 'payout_decision',
      entity_type: 'payout',
      entity_id: 'p-1',
      performed_by: 'system',
      // Keys deliberately out of order — the canonical form must sort them.
      details: { note: 'n', accountId: '100074', decision: 'approve' },
    });

    const [, args] = rpcMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(args.p_details_canonical).toBe(
      JSON.stringify({ accountId: '100074', decision: 'approve', note: 'n' })
    );
  });

  it('returns null without a second insert when the RPC fails for a non-missing-function reason', async () => {
    const rpcMock = vi.fn(async () => ({ data: null, error: { code: '23505', message: 'db error' } }));
    const fromMock = vi.fn(() => {
      throw new Error('fallback insert path should not run on a real RPC failure');
    });
    createAdminClientMock.mockReturnValue({ rpc: rpcMock, from: fromMock });
    const { logAuditEvent } = await import('./chain');

    const result = await logAuditEvent({
      action_type: 'payout_decision',
      entity_type: 'payout',
      entity_id: 'p-1',
      performed_by: 'system',
      details: {},
    });

    expect(result).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('returns null and swallows the error when the insert fails', async () => {
    createAdminClientMock.mockReturnValue(
      buildSupabaseMock({ previousHash: 'GENESIS', insertError: { message: 'insert failed' } })
    );
    const { logAuditEvent } = await import('./chain');

    const result = await logAuditEvent({
      action_type: 'deduction_executed',
      entity_type: 'deduction',
      entity_id: 'ded-1',
      performed_by: 'system',
      details: {},
    });

    expect(result).toBeNull();
  });
});

describe('logAuditEvent (demo mode)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
    createAdminClientMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('no-ops and returns null without ever touching the admin client', async () => {
    const { logAuditEvent } = await import('./chain');

    const result = await logAuditEvent({
      action_type: 'deduction_executed',
      entity_type: 'deduction',
      entity_id: 'ded-1',
      performed_by: 'system',
      details: { amount: 100 },
    });

    expect(result).toBeNull();
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });
});
