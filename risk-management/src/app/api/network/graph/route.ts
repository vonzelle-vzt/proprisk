export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { DEMO_MODE, assetClassFromRequest } from '@/lib/demo';
import { buildNetworkGraph } from '@/lib/network/graph';
import { requireRiskUser } from '@/lib/auth/guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';

/**
 * GET /api/network/graph?assetClass=forex|futures
 *
 * Cluster/ring graph for the Network page: nodes (accounts), edges (copy
 * correlation, shared identity, coordinated payout, shared IP/device), and
 * clusters (connected components with confidence/severity/summary). In
 * DEMO_MODE this is composed from the mock fraud-hunter ring dataset; live
 * mode reads open/reviewing/confirmed `fraud_investigations` rows.
 */
export async function GET(request: NextRequest) {
  if (DEMO_MODE) {
    const graph = await buildNetworkGraph({ assetClass: assetClassFromRequest(request) });
    return NextResponse.json({ data: graph }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('network-graph', { windowMs: 60_000, maxRequests: 30 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    // The graph is built from fraud investigations, which are tenant-scoped:
    // without this the live path throws, and a ring graph that ignored the
    // tenant would draw one firm's accounts into another firm's network.
    const graph = await buildNetworkGraph({
      assetClass: assetClassFromRequest(request),
      tenantId: auth.tenantId,
    });
    return NextResponse.json({ data: graph }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (err) {
    logError('Failed to build network graph', err, {
      route: '/api/network/graph',
      category: 'database',
    });
    return NextResponse.json({ error: 'Failed to build network graph' }, { status: 500 });
  }
}
