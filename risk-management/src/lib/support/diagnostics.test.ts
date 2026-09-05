import { beforeEach, describe, expect, it, vi } from 'vitest';

const tenantsMaybeSingle = vi.fn();

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: tenantsMaybeSingle }),
      }),
    }),
  }),
}));

const tenantDbMock = vi.fn();
vi.mock('@/lib/db/tenant-scoped', () => ({
  tenantDb: (...args: unknown[]) => tenantDbMock(...args),
}));

vi.mock('@/lib/providers/registry', () => ({
  ALL_PROVIDER_IDS: ['tradovate', 'matchtrader'],
  getProviderConfig: (id: string) => ({ id, enabled: id === 'tradovate' }),
}));

import { gatherDiagnostics } from './diagnostics';

describe('gatherDiagnostics — attaches enough that a ticket is debuggable on arrival', () => {
  beforeEach(() => {
    tenantsMaybeSingle.mockReset();
    tenantDbMock.mockReset();
  });

  it('reports tenant identity, plan tier, and every known provider connection', async () => {
    tenantsMaybeSingle.mockResolvedValue({
      data: { id: 't1', name: 'Acme', plan_tier: 'starter' },
      error: null,
    });
    tenantDbMock.mockReturnValue({
      select: () => ({ or: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
    });

    const result = await gatherDiagnostics('t1');

    expect(result.tenant).toEqual({ id: 't1', name: 'Acme', planTier: 'starter' });
    expect(result.connections).toEqual([
      { provider: 'tradovate', enabled: true },
      { provider: 'matchtrader', enabled: false },
    ]);
  });

  it('surfaces recent error-ish audit_log entries', async () => {
    tenantsMaybeSingle.mockResolvedValue({ data: null, error: null });
    tenantDbMock.mockReturnValue({
      select: () => ({
        or: () => ({
          order: () => ({
            limit: async () => ({
              data: [{ action_type: 'sync_error', created_at: '2026-01-01T00:00:00Z' }],
              error: null,
            }),
          }),
        }),
      }),
    });

    const result = await gatherDiagnostics('t1');

    expect(result.recentErrors).toEqual([{ action: 'sync_error', occurredAt: '2026-01-01T00:00:00Z' }]);
  });

  // Diagnostics gathering must never be the reason a ticket fails to file —
  // a piece that can't be fetched degrades to null/empty instead of throwing.
  it('degrades to null/empty when a piece is unavailable, rather than throwing', async () => {
    tenantsMaybeSingle.mockRejectedValue(new Error('db unreachable'));
    tenantDbMock.mockImplementation(() => {
      throw new Error('MissingTenantError');
    });

    const result = await gatherDiagnostics('t1');

    expect(result.tenant).toBeNull();
    expect(result.recentErrors).toEqual([]);
    expect(result.connections.length).toBe(2);
  });
});
