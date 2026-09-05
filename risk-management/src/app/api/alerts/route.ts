export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { DEMO_MODE, assetClassFromRequest } from '@/lib/demo';
import { buildAlerts } from '@/lib/mock/builders';
import { listLiveAlerts } from '@/lib/alerts/list';
import { requireRiskUser } from '@/lib/auth/guards';

/**
 * GET /api/alerts — live risk/breach alerts for the current asset class.
 * In DEMO_MODE this is derived from the mock dataset (futures `canTrade=false`
 * breaches + high/critical violations). Live mode used to unconditionally
 * return an empty feed — no live alerting existed. It's now backed by
 * `risk_alerts` via `tenantDb`, scoped to the signed-in user's tenant.
 */
export async function GET(request: Request) {
  if (DEMO_MODE) return Response.json(buildAlerts(assetClassFromRequest(request)));

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const result = await listLiveAlerts(auth.tenantId);
  return NextResponse.json(result);
}
