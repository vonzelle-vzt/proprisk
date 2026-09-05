import { NextRequest, NextResponse } from 'next/server';
import { validationErrorResponse } from '@/lib/api/schemas';
import { createIngestKeyBodySchema } from '@/lib/ingest/schemas';
import { createIngestKey } from '@/lib/ingest/keys';
import { requireTenantAdmin } from '@/lib/tenancy/guards';

export const dynamic = 'force-dynamic';

/**
 * Mints an equity-snapshot ingest key for the calling tenant. THIS endpoint
 * is session-authenticated (owner|admin, like every other tenancy-admin
 * surface) — a human on the risk team is provisioning credentials for their
 * own bridge process. The key that comes back is used for a completely
 * different kind of request (POST /api/ingest/equity-snapshots), which is
 * machine-to-machine and deliberately has no session.
 *
 * The raw key is returned exactly once, in this response. Only its hash is
 * ever persisted (src/lib/ingest/keys.ts) — losing it means minting a new
 * one, not recovering the old one.
 */
export async function POST(request: NextRequest) {
  const auth = await requireTenantAdmin();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => ({}));
  const parsed = createIngestKeyBodySchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  const result = await createIngestKey({
    tenantId: auth.tenantId,
    label: parsed.data.label,
    createdBy: auth.user.id,
  });

  return NextResponse.json({ data: result });
}
