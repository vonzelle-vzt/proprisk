import { NextRequest, NextResponse } from 'next/server';
import { validationErrorResponse } from '@/lib/api/schemas';
import { signupBodySchema } from '@/lib/tenancy/schemas';
import { provisionTenant } from '@/lib/tenancy/provision';

export const dynamic = 'force-dynamic';

// Public: a firm signing up has no session yet. Listed in
// PUBLIC_API_PREFIXES in middleware.ts.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = signupBodySchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  try {
    const result = await provisionTenant({
      firmName: parsed.data.firmName,
      ownerEmail: parsed.data.ownerEmail,
      ownerPassword: parsed.data.ownerPassword,
    });
    return NextResponse.json(
      { tenantId: result.tenantId, slug: result.slug },
      { status: 201 }
    );
  } catch (err) {
    // Supabase surfaces a duplicate-email createUser failure as a generic
    // error; the only actionable detail worth exposing to the client is
    // "this didn't work", not the underlying message.
    const message = err instanceof Error ? err.message : 'Signup failed';
    const isDuplicate = /already.*registered|already exists/i.test(message);
    return NextResponse.json(
      { error: isDuplicate ? 'An account with that email already exists' : 'Signup failed' },
      { status: isDuplicate ? 409 : 500 }
    );
  }
}
