import { beforeEach, describe, expect, it, vi } from 'vitest';

const upsertSubscriptionMock = vi.fn();
const findTenantIdByStripeCustomerIdMock = vi.fn();
const tierForPriceIdMock = vi.fn();

vi.mock('./subscriptions', () => ({
  upsertSubscription: (...args: unknown[]) => upsertSubscriptionMock(...args),
  findTenantIdByStripeCustomerId: (...args: unknown[]) => findTenantIdByStripeCustomerIdMock(...args),
  tierForPriceId: (...args: unknown[]) => tierForPriceIdMock(...args),
}));

import { processStripeEvent } from './webhook-handler';

beforeEach(() => {
  vi.clearAllMocks();
});

function event(type: string, object: unknown) {
  return { type, data: { object } } as never;
}

describe('checkout.session.completed', () => {
  it('upserts the subscription using the tenant carried on the session', async () => {
    await processStripeEvent(
      event('checkout.session.completed', {
        client_reference_id: 'tenant-1',
        customer: 'cus_123',
        subscription: 'sub_123',
        metadata: { tenant_id: 'tenant-1', plan_tier: 'growth' },
      })
    );

    expect(upsertSubscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: 'sub_123',
        planTier: 'growth',
        status: 'active',
      })
    );
  });

  it('does nothing for an unattributable session rather than guessing a tenant', async () => {
    await processStripeEvent(
      event('checkout.session.completed', { client_reference_id: null, customer: 'cus_999', metadata: {} })
    );

    expect(upsertSubscriptionMock).not.toHaveBeenCalled();
  });
});

describe('customer.subscription.updated', () => {
  it('resolves plan tier from the subscription price when available', async () => {
    tierForPriceIdMock.mockReturnValue('scale');

    await processStripeEvent(
      event('customer.subscription.updated', {
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        metadata: { tenant_id: 'tenant-1' },
        items: { data: [{ price: { id: 'price_scale' }, current_period_end: 1_700_000_000 }] },
      })
    );

    expect(tierForPriceIdMock).toHaveBeenCalledWith('price_scale');
    expect(upsertSubscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', planTier: 'scale', status: 'active' })
    );
  });

  it('falls back to looking up the tenant by Stripe customer id when metadata is missing', async () => {
    findTenantIdByStripeCustomerIdMock.mockResolvedValue('tenant-2');
    tierForPriceIdMock.mockReturnValue(null);

    await processStripeEvent(
      event('customer.subscription.updated', {
        id: 'sub_2',
        customer: 'cus_2',
        status: 'past_due',
        metadata: {},
        items: { data: [{ price: { id: 'price_unknown' } }] },
      })
    );

    expect(findTenantIdByStripeCustomerIdMock).toHaveBeenCalledWith('cus_2');
    expect(upsertSubscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-2', status: 'past_due' })
    );
  });

  it('maps a lapsed/unpaid Stripe status onto the row without ever touching account monitoring', async () => {
    tierForPriceIdMock.mockReturnValue('starter');

    await processStripeEvent(
      event('customer.subscription.updated', {
        id: 'sub_3',
        customer: 'cus_3',
        status: 'unpaid',
        metadata: { tenant_id: 'tenant-3' },
        items: { data: [{ price: { id: 'price_starter' } }] },
      })
    );

    // This handler's only side effect is the billing-row upsert; it has no
    // access to accounts/violations/enforcement tables at all, so a lapsed
    // invoice can update `subscriptions.status` and nothing else.
    expect(upsertSubscriptionMock).toHaveBeenCalledTimes(1);
    expect(upsertSubscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'unpaid' })
    );
  });
});

describe('customer.subscription.deleted', () => {
  it('marks the subscription canceled', async () => {
    tierForPriceIdMock.mockReturnValue('growth');

    await processStripeEvent(
      event('customer.subscription.deleted', {
        id: 'sub_4',
        customer: 'cus_4',
        metadata: { tenant_id: 'tenant-4' },
        items: { data: [{ price: { id: 'price_growth' } }] },
      })
    );

    expect(upsertSubscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-4', status: 'canceled' })
    );
  });
});

describe('unhandled event types', () => {
  it('is a no-op', async () => {
    await processStripeEvent(event('invoice.payment_failed', {}));
    expect(upsertSubscriptionMock).not.toHaveBeenCalled();
  });
});
