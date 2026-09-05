import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUserMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: () => getUserMock() } }),
}));

import { actorLabel, requireRiskManager, requireRiskUser } from './guards';

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';

/**
 * Every guard now requires a tenant claim as well as a role, so the default
 * fixture carries one; tests that care about the tenant override it explicitly.
 */
function user(overrides: Record<string, unknown> = {}) {
  const { app_metadata, ...rest } = overrides as { app_metadata?: Record<string, unknown> };
  return {
    data: {
      user: {
        id: 'user-1',
        email: 'dana@firm.com',
        app_metadata: { tenant_id: TENANT, ...(app_metadata ?? {}) },
        user_metadata: {},
        ...rest,
      },
    },
    error: null,
  };
}

describe('requireRiskUser — role source', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts a role from app_metadata', async () => {
    getUserMock.mockResolvedValue(user({ app_metadata: { role: 'risk_manager' } }));

    const result = await requireRiskUser();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.role).toBe('risk_manager');
  });

  // user_metadata is writable by the user themselves via supabase.auth.updateUser().
  // Honouring a role from it would let any signed-in analyst self-promote to admin.
  it('IGNORES a role planted in user_metadata', async () => {
    getUserMock.mockResolvedValue(
      user({ app_metadata: {}, user_metadata: { role: 'admin' } })
    );

    const result = await requireRiskUser();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it('does not let user_metadata override a lower app_metadata role', async () => {
    getUserMock.mockResolvedValue(
      user({ app_metadata: { role: 'risk_analyst' }, user_metadata: { role: 'admin' } })
    );

    const result = await requireRiskUser();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.role).toBe('risk_analyst');
    // And that planted role must not be enough to clear the manager gate.
    getUserMock.mockResolvedValue(
      user({ app_metadata: { role: 'risk_analyst' }, user_metadata: { role: 'admin' } })
    );
    const managerResult = await requireRiskManager();
    expect(managerResult.ok).toBe(false);
  });

  // Absence of a role is a denial, not a default — an unprovisioned account
  // must not inherit access to money-moving surfaces.
  it('denies a user with no role at all', async () => {
    getUserMock.mockResolvedValue(user({ app_metadata: {} }));

    const result = await requireRiskUser();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it('denies a non-string role', async () => {
    getUserMock.mockResolvedValue(user({ app_metadata: { role: { name: 'admin' } } }));

    const result = await requireRiskUser();

    expect(result.ok).toBe(false);
  });

  it('returns 401 when there is no session', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });

    const result = await requireRiskUser();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });
});

describe('requireRiskManager', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['risk_manager', 'admin'])('admits %s', async (role) => {
    getUserMock.mockResolvedValue(user({ app_metadata: { role } }));

    const result = await requireRiskManager();

    expect(result.ok).toBe(true);
  });

  it('refuses risk_analyst with 403', async () => {
    getUserMock.mockResolvedValue(user({ app_metadata: { role: 'risk_analyst' } }));

    const result = await requireRiskManager();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });
});

describe('actorLabel', () => {
  it('prefers email', () => {
    expect(actorLabel({ id: 'user-1', email: 'dana@firm.com' } as never)).toBe('dana@firm.com');
  });

  it('falls back to the immutable id when there is no email', () => {
    expect(actorLabel({ id: 'user-1', email: undefined } as never)).toBe('user-1');
  });
});

describe('guard results carry an actor for the audit trail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes actor on a successful guard', async () => {
    getUserMock.mockResolvedValue(user({ app_metadata: { role: 'admin' } }));

    const result = await requireRiskUser();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actor).toBe('dana@firm.com');
      expect(result.user.id).toBe('user-1');
    }
  });
});

describe('tenant claim', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes the tenant id on a successful guard', async () => {
    getUserMock.mockResolvedValue(user({ app_metadata: { role: 'admin' } }));

    const result = await requireRiskUser();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tenantId).toBe(TENANT);
  });

  // A session with a valid role but no tenant must be unusable, not global.
  // The RLS predicates agree — a NULL claim fails every policy closed — but the
  // application must not depend on the database to catch it.
  it('refuses a session with a role but no tenant', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'x@y.com', app_metadata: { role: 'admin' }, user_metadata: {} } },
      error: null,
    });

    const result = await requireRiskUser();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it('ignores a tenant planted in user_metadata', async () => {
    getUserMock.mockResolvedValue({
      data: {
        user: {
          id: 'user-1',
          email: 'x@y.com',
          app_metadata: { role: 'admin' },
          user_metadata: { tenant_id: 'bbbbbbbb-0000-0000-0000-000000000002' },
        },
      },
      error: null,
    });

    const result = await requireRiskUser();

    expect(result.ok).toBe(false);
  });

  it('refuses a non-string tenant claim', async () => {
    getUserMock.mockResolvedValue(user({ app_metadata: { role: 'admin', tenant_id: 12345 } }));

    const result = await requireRiskUser();

    expect(result.ok).toBe(false);
  });
});
