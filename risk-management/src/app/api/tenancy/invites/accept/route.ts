import { NextRequest, NextResponse } from 'next/server';
import { validationErrorResponse } from '@/lib/api/schemas';
import { acceptInviteBodySchema } from '@/lib/tenancy/schemas';
import { InvalidInviteError, redeemInvite } from '@/lib/tenancy/invites';

export const dynamic = 'force-dynamic';

// Public: the redeemer has no session (and no tenant claim) until this call
// succeeds. Listed in PUBLIC_API_PREFIXES in middleware.ts. Note there is no
// tenant id anywhere in the request body — the tenant comes only from the
// invite the token hashes to, so this endpoint structurally cannot redeem an
// invite into any tenant other than the one that issued it.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = acceptInviteBodySchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  try {
    const result = await redeemInvite({
      token: parsed.data.token,
      password: parsed.data.password,
    });
    return NextResponse.json(
      { tenantId: result.tenantId, role: result.role, email: result.email },
      { status: 200 }
    );
  } catch (err) {
    if (err instanceof InvalidInviteError) {
      return NextResponse.json({ error: 'Invite is invalid or expired' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to accept invite' }, { status: 500 });
  }
}
