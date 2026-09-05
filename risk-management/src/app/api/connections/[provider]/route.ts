import { NextRequest, NextResponse } from 'next/server';
import { DEMO_MODE } from '@/lib/demo';
import { requireRiskManager, requireRiskUser } from '@/lib/auth/guards';
import { deleteConnection, getConnection, upsertConnection } from '@/lib/connections/store';
import { providerIdSchema, upsertConnectionBodySchema } from '@/lib/connections/schemas';
import { validationErrorResponse } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

/** GET /api/connections/:provider — one connection, redacted. */
export async function GET(_request: NextRequest, { params }: { params: { provider: string } }) {
  if (DEMO_MODE) return NextResponse.json({ connection: null, demo: true });

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const parsedProvider = providerIdSchema.safeParse(params.provider);
  if (!parsedProvider.success) return NextResponse.json({ error: 'Unknown provider' }, { status: 404 });

  try {
    const connection = await getConnection(auth.tenantId, parsedProvider.data);
    if (!connection) return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    return NextResponse.json({ connection });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** PUT /api/connections/:provider — update this tenant's connection for the provider. */
export async function PUT(request: NextRequest, { params }: { params: { provider: string } }) {
  if (DEMO_MODE)
    return NextResponse.json({ ok: true, demo: true, message: 'Demo: connection not actually saved.' });

  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

  const parsedProvider = providerIdSchema.safeParse(params.provider);
  if (!parsedProvider.success) return NextResponse.json({ error: 'Unknown provider' }, { status: 404 });

  const body = await request.json().catch(() => null);
  const parsed = upsertConnectionBodySchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  try {
    const connection = await upsertConnection(auth.tenantId, parsedProvider.data, {
      ...parsed.data,
      actor: auth.actor,
    });
    return NextResponse.json({ connection });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** DELETE /api/connections/:provider — remove this tenant's connection (reverts that provider to unconfigured). */
export async function DELETE(_request: NextRequest, { params }: { params: { provider: string } }) {
  if (DEMO_MODE)
    return NextResponse.json({ ok: true, demo: true, message: 'Demo: connection not actually removed.' });

  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

  const parsedProvider = providerIdSchema.safeParse(params.provider);
  if (!parsedProvider.success) return NextResponse.json({ error: 'Unknown provider' }, { status: 404 });

  try {
    await deleteConnection(auth.tenantId, parsedProvider.data);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
