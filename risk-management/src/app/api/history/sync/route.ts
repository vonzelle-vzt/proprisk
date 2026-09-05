export const dynamic = 'force-dynamic';

import { syncExternalPayouts } from '@/lib/payouts/sync-external';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { DEMO_MODE } from '@/lib/demo';
import { requireRiskUser } from '@/lib/auth/guards';

/**
 * POST — Trigger sync of externally-decided payouts from the provider platform into payout_history.
 * Deduplication in Supabase (unique constraint) prevents double inserts.
 * Called automatically by the history page hook on mount; batched to avoid timeout.
 */
export async function POST() {
  if (DEMO_MODE) return Response.json({ status: 'completed', synced: 0, remaining: 0 });

  // This route had no guard at all: it pulls payout history from the trading
  // platform and writes it to the database, so an unguarded call was an
  // unauthenticated write triggered by anyone who could reach the endpoint.
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('history-sync', { windowMs: 60000, maxRequests: 4 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const result = await syncExternalPayouts(auth.tenantId);
    return Response.json({ status: 'completed', ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sync failed';
    return Response.json({ error: msg }, { status: 500 });
  }
}
