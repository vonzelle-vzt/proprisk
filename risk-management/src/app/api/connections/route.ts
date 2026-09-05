import { NextRequest, NextResponse } from 'next/server';
import { DEMO_MODE } from '@/lib/demo';
import { requireRiskManager, requireRiskUser } from '@/lib/auth/guards';
import { listConnections, upsertConnection } from '@/lib/connections/store';
import { providerIdSchema, upsertConnectionBodySchema } from '@/lib/connections/schemas';
import { validationErrorResponse } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

const createConnectionBodySchema = upsertConnectionBodySchema.extend({
  providerId: providerIdSchema,
});

/**
 * GET /api/connections — this tenant's provider connections, redacted (a
 * masked preview of each secret, never the value). Demo mode never reaches
 * the database (the service-role client throws), so it returns an empty list —
 * the Connections page in demo shows the provider registry's mock/env state
 * instead, same as /api/providers.
 */
export async function GET() {
  if (DEMO_MODE) return NextResponse.json({ connections: [], demo: true });

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  try {
    const connections = await listConnections(auth.tenantId);
    return NextResponse.json({ connections });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/connections — create or replace this tenant's connection for one
 * provider. Credentials management is enforcement-adjacent (a bad key change
 * can take a whole desk offline), so it's gated the same as enforcement:
 * risk_manager or admin only.
 */
export async function POST(request: NextRequest) {
  if (DEMO_MODE)
    return NextResponse.json({ ok: true, demo: true, message: 'Demo: connection not actually saved.' });

  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = createConnectionBodySchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  const { providerId, assetClass, enabled, apiUrl, secrets } = parsed.data;

  try {
    const connection = await upsertConnection(auth.tenantId, providerId, {
      assetClass,
      enabled,
      apiUrl,
      secrets,
      actor: auth.actor,
    });
    return NextResponse.json({ connection }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
