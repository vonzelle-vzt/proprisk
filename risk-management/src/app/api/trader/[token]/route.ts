import { NextRequest, NextResponse } from 'next/server';
import { DEMO_MODE } from '@/lib/demo';
import { loadTraderView } from '@/lib/trader/data';
import { DEMO_TRADER_TOKEN } from '@/lib/trader/demo';
import { verifyTraderToken } from '@/lib/trader/tokens';

export const dynamic = 'force-dynamic';

/**
 * The entire trader-facing API. Public (listed in PUBLIC_API_PREFIXES) —
 * traders have no Supabase session, so the token in the URL is the whole
 * authentication boundary. Every request re-verifies it: no server-side
 * session is ever established for a trader, so there is nothing to cache
 * across requests that could go stale or leak.
 *
 * A trader can reach EXACTLY the account their token names — `verifyTraderToken`
 * returns the (tenantId, accountId) pair the token itself hashes to, and
 * `loadTraderView` is scoped to that pair via `tenantDb`, so there is no
 * parameter anywhere in this path a caller could substitute to reach a
 * different account or a different firm's data.
 */
export async function GET(_request: NextRequest, { params }: { params: { token: string } }) {
  // Demo mode has no real database and no real tokens to verify against —
  // the service-role client `verifyTraderToken` depends on is structurally
  // disabled in demo mode (see src/lib/supabase/admin.ts). Only the single
  // fixed demo token resolves to anything; every other token gets the same
  // 404 a bad token gets in live mode, never a 500.
  if (DEMO_MODE) {
    if (params.token !== DEMO_TRADER_TOKEN) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const view = await loadTraderView(DEMO_TRADER_TOKEN, DEMO_TRADER_TOKEN);
    if (!view) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(view);
  }

  const verified = await verifyTraderToken(params.token);
  // Undifferentiated 404 for "not found", "expired" and "revoked" alike —
  // telling a caller which one narrows their search for a valid link.
  if (!verified) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const view = await loadTraderView(verified.tenantId, verified.accountId);
  if (!view) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json(view);
}
