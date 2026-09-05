import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAdmin } from '@/lib/tenancy/guards';
import { validationErrorResponse } from '@/lib/api/schemas';
import { checkoutBodySchema } from '@/lib/billing/schemas';
import { createCheckoutSession, MissingStripePriceError } from '@/lib/billing/checkout';
import { BILLING_ENABLED, BILLING_DISABLED_MESSAGE } from '@/lib/billing/config';

export const dynamic = 'force-dynamic';

/**
 * POST /api/billing/checkout — start (or change) a tenant's subscription.
 * Billing is owner|admin work, same gate as roster management
 * (`requireTenantAdmin`) — a risk_analyst has no reason to touch the invoice.
 *
 * Off by default: a self-hosted deployment has no Stripe account, so the
 * flag check comes FIRST — before the session lookup, before body parsing —
 * so nothing here can reach an unconfigured Stripe client.
 */
export async function POST(request: NextRequest) {
  if (!BILLING_ENABLED) {
    return NextResponse.json({ error: BILLING_DISABLED_MESSAGE }, { status: 404 });
  }

  const auth = await requireTenantAdmin();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = checkoutBodySchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  try {
    const { url } = await createCheckoutSession({
      tenantId: auth.tenantId,
      planTier: parsed.data.planTier,
      ownerEmail: auth.user.email ?? '',
    });
    return NextResponse.json({ url });
  } catch (err) {
    if (err instanceof MissingStripePriceError) {
      return NextResponse.json({ error: err.message }, { status: 501 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
