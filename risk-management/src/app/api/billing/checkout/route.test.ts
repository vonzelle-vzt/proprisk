import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

/**
 * The billing flag is the whole point of these tests: on a self-hosted
 * deployment (BILLING_ENABLED unset, the default) this endpoint must not
 * exist, and it must decide that BEFORE it authenticates anyone or reads a
 * body — there is no Stripe account behind it to reach.
 */
const { billingFlag, requireTenantAdminMock, createCheckoutSessionMock, MissingStripePriceError } =
  vi.hoisted(() => {
    class MissingStripePriceError extends Error {}
    return {
      billingFlag: { enabled: true },
      requireTenantAdminMock: vi.fn(),
      createCheckoutSessionMock: vi.fn(),
      MissingStripePriceError,
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
  createCheckoutSession: (...args: unknown[]) => createCheckoutSessionMock(...args),
  MissingStripePriceError,
}));

import { POST } from './route';

function buildRequest(body: unknown) {
  return { json: async () => body } as unknown as Request;
}

const adminAuth = {
  ok: true as const,
  user: { email: 'owner@firm.test' },
  role: 'owner',
  tenantId: 'tenant-1',
};

describe('POST /api/billing/checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    billingFlag.enabled = true;
  });

  it('404s when billing is not enabled, without authenticating or parsing anything', async () => {
    billingFlag.enabled = false;

    const res = await POST(buildRequest({ planTier: 'starter' }) as never);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: 'Billing is not enabled on this deployment',
    });
    // The flag is checked first: no session lookup, no Stripe call.
    expect(requireTenantAdminMock).not.toHaveBeenCalled();
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('still runs the real owner|admin gate when billing IS enabled', async () => {
    requireTenantAdminMock.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    });

    const res = await POST(buildRequest({ planTier: 'starter' }) as never);

    expect(res.status).toBe(403);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('creates a checkout session when billing is enabled and the caller is an admin', async () => {
    requireTenantAdminMock.mockResolvedValueOnce(adminAuth);
    createCheckoutSessionMock.mockResolvedValueOnce({ url: 'https://checkout.stripe.test/s/abc' });

    const res = await POST(buildRequest({ planTier: 'growth' }) as never);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ url: 'https://checkout.stripe.test/s/abc' });
    expect(createCheckoutSessionMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      planTier: 'growth',
      ownerEmail: 'owner@firm.test',
    });
  });

  it('reports an unconfigured price as 501 rather than a generic failure', async () => {
    requireTenantAdminMock.mockResolvedValueOnce(adminAuth);
    createCheckoutSessionMock.mockRejectedValueOnce(
      new MissingStripePriceError('No Stripe price configured for plan "scale"')
    );

    const res = await POST(buildRequest({ planTier: 'scale' }) as never);

    expect(res.status).toBe(501);
  });
});
