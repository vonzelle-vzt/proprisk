import { NextResponse } from 'next/server';
import { requireTenantAdmin } from '@/lib/tenancy/guards';
import { createPortalSession, NoStripeCustomerError } from '@/lib/billing/checkout';
import { BILLING_ENABLED, BILLING_DISABLED_MESSAGE } from '@/lib/billing/config';

export const dynamic = 'force-dynamic';

/**
 * POST /api/billing/portal — a link into Stripe's hosted customer portal
 * (invoices, payment method, cancel/upgrade). Same owner|admin gate as
 * checkout — see src/app/api/billing/checkout/route.ts — and the same
 * billing-flag check ahead of it.
 */
export async function POST() {
  if (!BILLING_ENABLED) {
    return NextResponse.json({ error: BILLING_DISABLED_MESSAGE }, { status: 404 });
  }

  const auth = await requireTenantAdmin();
  if (!auth.ok) return auth.response;

  try {
    const { url } = await createPortalSession(auth.tenantId);
    return NextResponse.json({ url });
  } catch (err) {
    if (err instanceof NoStripeCustomerError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
