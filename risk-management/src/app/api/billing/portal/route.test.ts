import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

/**
 * Same contract as the checkout route (see its route.test.ts): with billing
 * off this endpoint does not exist, and it says so before touching a session
 * or Stripe.
 */
const { billingFlag, requireTenantAdminMock, createPortalSessionMock, NoStripeCustomerError } =
  vi.hoisted(() => {
    class NoStripeCustomerError extends Error {}
    return {
      billingFlag: { enabled: true },
      requireTenantAdminMock: vi.fn(),
      createPortalSessionMock: vi.fn(),
      NoStripeCustomerError,
    };
  });

vi.mock('@/lib/billing/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/config')>()),
  get BILLING_ENABLED() {
    return billingFlag.enabled;
  },
}));

vi.mock('@/lib/tenancy/guards', () => ({
  requireTenantAdmin: () => requireTenantAdminMock(),
}));

vi.mock('@/lib/billing/checkout', () => ({
  createPortalSession: (...args: unknown[]) => createPortalSessionMock(...args),
  NoStripeCustomerError,
}));

import { POST } from './route';

const adminAuth = {
  ok: true as const,
  user: { email: 'owner@firm.test' },
  role: 'owner',
  tenantId: 'tenant-1',
};

describe('POST /api/billing/portal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    billingFlag.enabled = true;
  });

  it('404s when billing is not enabled, without authenticating anyone', async () => {
    billingFlag.enabled = false;

    const res = await POST();

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: 'Billing is not enabled on this deployment',
    });
    expect(requireTenantAdminMock).not.toHaveBeenCalled();
    expect(createPortalSessionMock).not.toHaveBeenCalled();
  });

  it('still runs the real owner|admin gate when billing IS enabled', async () => {
    requireTenantAdminMock.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });

    const res = await POST();

    expect(res.status).toBe(401);
    expect(createPortalSessionMock).not.toHaveBeenCalled();
  });

  it('returns the portal URL when billing is enabled and the caller is an admin', async () => {
    requireTenantAdminMock.mockResolvedValueOnce(adminAuth);
    createPortalSessionMock.mockResolvedValueOnce({ url: 'https://billing.stripe.test/p/xyz' });

    const res = await POST();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ url: 'https://billing.stripe.test/p/xyz' });
    expect(createPortalSessionMock).toHaveBeenCalledWith('tenant-1');
  });

  it('reports a tenant that has never checked out as 409, not a server error', async () => {
    requireTenantAdminMock.mockResolvedValueOnce(adminAuth);
    createPortalSessionMock.mockRejectedValueOnce(
      new NoStripeCustomerError('This tenant has no Stripe customer yet')
    );

    const res = await POST();

    expect(res.status).toBe(409);
  });
});
