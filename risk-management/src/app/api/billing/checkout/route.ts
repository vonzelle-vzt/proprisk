import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAdmin } from '@/lib/tenancy/guards';
import { validationErrorResponse } from '@/lib/api/schemas';
import { checkoutBodySchema } from '@/lib/billing/schemas';
import { createCheckoutSession, MissingStripePriceError } from '@/lib/billing/checkout';

export const dynamic = 'force-dynamic';

/**
 * POST /api/billing/checkout — start (or change) a tenant's subscription.
 * Billing is owner|admin work, same gate as roster management
 * (`requireTenantAdmin`) — a risk_analyst has no reason to touch the invoice.
 */
export async function POST(request: NextRequest) {
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
