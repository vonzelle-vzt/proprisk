import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUserMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: () => getUserMock() } }),
}));

import { requireTenantAdmin, requireTenantMember } from './guards';

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';

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

describe('requireTenantAdmin', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['owner', 'admin'])('admits %s', async (role) => {
    getUserMock.mockResolvedValue(user({ app_metadata: { role } }));

    const result = await requireTenantAdmin();

    expect(result.ok).toBe(true);
  });

  // requireRiskManager (src/lib/auth/guards.ts) admits risk_manager/admin for
  // the risk desk; this gate is the roster/invite surface and must not admit
  // a risk role that has no business changing who is on the team.
  it('refuses risk_analyst', async () => {
    getUserMock.mockResolvedValue(user({ app_metadata: { role: 'risk_analyst' } }));

    const result = await requireTenantAdmin();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it('refuses a user with no tenant claim', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'x@y.com', app_metadata: { role: 'owner' } } },
      error: null,
    });

    const result = await requireTenantAdmin();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it('returns 401 with no session', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });

    const result = await requireTenantAdmin();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });
});

describe('requireTenantMember', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['owner', 'admin', 'risk_manager', 'risk_analyst', 'viewer'])(
    'admits any tenant role: %s',
    async (role) => {
      getUserMock.mockResolvedValue(user({ app_metadata: { role } }));

      const result = await requireTenantMember();

      expect(result.ok).toBe(true);
    }
  );

  it('refuses a user with no tenant claim, even with a role', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'x@y.com', app_metadata: { role: 'viewer' } } },
      error: null,
    });

    const result = await requireTenantMember();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });
});
