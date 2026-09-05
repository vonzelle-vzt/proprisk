import { beforeEach, describe, expect, it, vi } from 'vitest';

const constructEventMock = vi.fn();
const processStripeEventMock = vi.fn();

vi.mock('@/lib/billing/stripe-client', () => ({
  getStripeClient: () => ({ webhooks: { constructEvent: constructEventMock } }),
}));

vi.mock('@/lib/billing/webhook-handler', () => ({
  processStripeEvent: (...args: unknown[]) => processStripeEventMock(...args),
}));

// Billing is off by default (BILLING_ENABLED unset), which would 404 every
// case below before it reached the signature logic. Mocked as a live getter
// so the flag-off case can be asserted in the same file.
const billingFlag = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/lib/billing/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/config')>()),
  get BILLING_ENABLED() {
    return billingFlag.enabled;
  },
}));

import { POST } from './route';

function buildRequest(opts: { signature?: string | null; body?: string }) {
  return {
    headers: { get: (name: string) => (name === 'stripe-signature' ? opts.signature ?? null : null) },
    text: async () => opts.body ?? '{}',
  } as unknown as Request;
}

describe('POST /api/billing/webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    billingFlag.enabled = true;
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  });

  it('404s when billing is not enabled, without reading the request at all', async () => {
    billingFlag.enabled = false;
    // Even the best-case caller — a signing secret configured and a signature
    // present — gets nothing: with Stripe off there is no account that could
    // have signed this, so there is no such endpoint.
    const res = await POST(buildRequest({ signature: 'sig_whatever' }) as never);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: 'Billing is not enabled on this deployment',
    });
    expect(constructEventMock).not.toHaveBeenCalled();
    expect(processStripeEventMock).not.toHaveBeenCalled();
  });

  it('rejects a request with no stripe-signature header WITHOUT touching the event handler', async () => {
    const res = await POST(buildRequest({ signature: null }) as never);

    expect(res.status).toBe(401);
    expect(constructEventMock).not.toHaveBeenCalled();
    expect(processStripeEventMock).not.toHaveBeenCalled();
  });

  it('rejects a request when STRIPE_WEBHOOK_SECRET is not configured, even with a signature header', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const res = await POST(buildRequest({ signature: 'sig_whatever' }) as never);

    expect(res.status).toBe(401);
    expect(processStripeEventMock).not.toHaveBeenCalled();
  });

  it('rejects a signature Stripe cannot verify WITHOUT processing the event — the signature is the only auth', async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });

    const res = await POST(buildRequest({ signature: 'bad-signature', body: '{"malicious":true}' }) as never);

    expect(res.status).toBe(400);
    expect(processStripeEventMock).not.toHaveBeenCalled();
  });

  it('processes the event only after a signature verifies', async () => {
    const fakeEvent = { type: 'checkout.session.completed', data: { object: {} } };
    constructEventMock.mockReturnValue(fakeEvent);
    processStripeEventMock.mockResolvedValue(undefined);

    const res = await POST(buildRequest({ signature: 'good-signature' }) as never);

    expect(res.status).toBe(200);
    expect(processStripeEventMock).toHaveBeenCalledWith(fakeEvent);
  });

  it('returns 500 (so Stripe retries) rather than silently dropping a processing failure', async () => {
    constructEventMock.mockReturnValue({ type: 'customer.subscription.updated', data: { object: {} } });
    processStripeEventMock.mockRejectedValue(new Error('db unreachable'));

    const res = await POST(buildRequest({ signature: 'good-signature' }) as never);

    expect(res.status).toBe(500);
  });
});
