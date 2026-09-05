import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskManager } from '@/lib/auth/guards';
import { accountLoginParamSchema, validationErrorResponse } from '@/lib/api/schemas';
import { createTraderLinkBodySchema, revokeTraderLinkQuerySchema } from '@/lib/trader/schemas';
import { issueTraderLink, listTraderLinks, revokeTraderLink } from '@/lib/trader/tokens';
import { DEMO_MODE } from '@/lib/demo';

export const dynamic = 'force-dynamic';

/**
 * Firm-side management of one account's trader link(s). Enforcement-grade
 * (a link exposes real account state to whoever holds it), so gated the same
 * as batch enforcement — `requireRiskManager`, not the broader `requireRiskUser`.
 *
 * Resolves `login` -> account id through the request-scoped client (RLS-
 * constrained to the signed-in user's own tenant), the same pattern
 * `src/app/api/accounts/[login]/route.ts` uses — never the admin client.
 */
async function resolveAccountId(login: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from('accounts').select('id').eq('login', login).single();
  if (error || !data) return null;
  return (data as { id: string }).id;
}

export async function GET(_request: NextRequest, { params }: { params: { login: string } }) {
  if (DEMO_MODE) return NextResponse.json({ error: 'Not available in demo mode' }, { status: 403 });

  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

  const parsedParams = accountLoginParamSchema.safeParse(params);
  if (!parsedParams.success) return validationErrorResponse(parsedParams.error);

  const accountId = await resolveAccountId(parsedParams.data.login);
  if (!accountId) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  const links = await listTraderLinks(auth.tenantId, accountId);
  return NextResponse.json({ data: links });
}

export async function POST(request: NextRequest, { params }: { params: { login: string } }) {
  if (DEMO_MODE) return NextResponse.json({ error: 'Not available in demo mode' }, { status: 403 });

  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

  const parsedParams = accountLoginParamSchema.safeParse(params);
  if (!parsedParams.success) return validationErrorResponse(parsedParams.error);

  const body = await request.json().catch(() => ({}));
  const parsedBody = createTraderLinkBodySchema.safeParse(body);
  if (!parsedBody.success) return validationErrorResponse(parsedBody.error);

  const accountId = await resolveAccountId(parsedParams.data.login);
  if (!accountId) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  const link = await issueTraderLink({
    tenantId: auth.tenantId,
    accountId,
    createdBy: auth.user.id,
    ttlDays: parsedBody.data.ttlDays,
  });

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
  return NextResponse.json(
    {
      id: link.id,
      url: `${baseUrl}/a/${link.token}`,
      expiresAt: link.expiresAt,
    },
    { status: 201 }
  );
}

export async function DELETE(request: NextRequest, { params }: { params: { login: string } }) {
  if (DEMO_MODE) return NextResponse.json({ error: 'Not available in demo mode' }, { status: 403 });

  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

  const parsedParams = accountLoginParamSchema.safeParse(params);
  if (!parsedParams.success) return validationErrorResponse(parsedParams.error);

  const query = Object.fromEntries(new URL(request.url).searchParams);
  const parsedQuery = revokeTraderLinkQuerySchema.safeParse(query);
  if (!parsedQuery.success) return validationErrorResponse(parsedQuery.error);

  await revokeTraderLink(auth.tenantId, parsedQuery.data.id);
  return NextResponse.json({ ok: true });
}
