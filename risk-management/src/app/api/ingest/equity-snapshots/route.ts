import { NextRequest, NextResponse } from 'next/server';
import { validationErrorResponse } from '@/lib/api/schemas';
import { pushEquitySnapshotsBodySchema } from '@/lib/ingest/schemas';
import { verifyIngestKey } from '@/lib/ingest/keys';
import { inputsFromPush, recordSnapshots, resolveAccountIdsByLogin } from '@/lib/ingest/snapshots';
import { logError } from '@/lib/logging/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Push path for equity snapshots — strictly better than polling for a firm
 * whose platform (or bridge process) can deliver balance/equity itself:
 * no poll interval to trade off against rate limits, and it can push at
 * whatever cadence the source actually changes.
 *
 * Authenticated with a per-tenant ingest key (`Authorization: Bearer isk_...`,
 * src/lib/ingest/keys.ts), NOT a session — this is machine-to-machine, there
 * is no signed-in user on a bridge process's request. Idempotent on
 * (account_id, captured_at) via the same unique index the poll path writes
 * through (supabase/migrations/00022), so a retried delivery is a no-op
 * rather than a duplicate.
 */
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const rawKey = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
  if (!rawKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const verified = await verifyIngestKey(rawKey);
  if (!verified) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = pushEquitySnapshotsBodySchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  try {
    const { byLogin, unresolved } = await resolveAccountIdsByLogin(
      verified.tenantId,
      parsed.data.snapshots.map((s) => s.account_login)
    );

    const writes = inputsFromPush(verified.tenantId, byLogin, parsed.data.snapshots);
    const written = writes.length > 0 ? await recordSnapshots(verified.tenantId, writes) : { written: 0, failed: 0 };

    return NextResponse.json({
      message: 'Equity snapshots ingested',
      written: written.written,
      failed: written.failed,
      unresolved_accounts: unresolved,
    });
  } catch (error: any) {
    logError('ingest/equity-snapshots failed', error, {
      category: 'database',
      tenant_id: verified.tenantId,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
