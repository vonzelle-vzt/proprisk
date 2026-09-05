import { NextRequest, NextResponse } from 'next/server';
import { validationErrorResponse } from '@/lib/api/schemas';
import { createInviteBodySchema } from '@/lib/tenancy/schemas';
import { createInvite } from '@/lib/tenancy/invites';
import { requireTenantAdmin } from '@/lib/tenancy/guards';
import { globalTable } from '@/lib/db/tenant-scoped';
import { sendEmail } from '@/lib/emails/transport';
import { brand } from '@/config/brand';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireTenantAdmin();
  if (!auth.ok) return auth.response;

  // `tenant_invites` is one of the tenancy tables managed directly (like
  // `tenants`/`tenant_members`) rather than through `tenantDb()` — see
  // GLOBAL_TABLES in src/lib/db/tenant-scoped.ts — so the tenant filter is
  // explicit here rather than implicit.
  const { data, error } = await globalTable('tenant_invites')
    .select('id, email, role, expires_at, accepted_at, created_at')
    .eq('tenant_id', auth.tenantId)
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: 'Internal server error' }, { status: 500 });

  return NextResponse.json({ data: data ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await requireTenantAdmin();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = createInviteBodySchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  const invite = await createInvite({
    tenantId: auth.tenantId,
    email: parsed.data.email,
    role: parsed.data.role,
    invitedBy: auth.user.id,
  });

  const acceptUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/accept-invite?token=${invite.token}`;
  try {
    await sendEmail({
      to: parsed.data.email,
      subject: `You've been invited to ${brand.productName}`,
      html: `
        <p>You've been invited to join ${brand.companyName} on ${brand.productName} as ${parsed.data.role}.</p>
        <p><a href="${acceptUrl}">Accept invite</a></p>
        <p>This link expires ${invite.expiresAt}.</p>
      `,
    });
  } catch {
    // The invite row already exists and is independently redeemable via the
    // link; email delivery failing must not fail the request, or an admin
    // with an unconfigured transport could never invite anyone at all. The
    // caller can hand the accept URL over out-of-band.
  }

  return NextResponse.json({ inviteId: invite.inviteId, expiresAt: invite.expiresAt }, { status: 201 });
}
