export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { computeLiabilityForecast } from '@/lib/forecast/liability';
import { DEMO_MODE, type AssetClass } from '@/lib/demo';
import { requireRiskUser } from '@/lib/auth/guards';

/**
 * GET /api/forecast/liability — deterministic payout-liability forecast
 * (pending queue + funded-pipeline arrivals) over a 7 or 30 day horizon,
 * with p50/p90 bands. Demo vs live data source is resolved inside
 * computeLiabilityForecast (DEMO_MODE), same shape as
 * src/app/api/exposure/route.ts.
 *
 * Query params:
 *   assetClass    'forex' | 'futures' (default 'forex')
 *   horizonDays   7 | 30 (default 7)
 *   approvalRate  optional override (0..1) for the scenario sliders
 *   deductionRate optional override (0..1) for the scenario sliders
 */
export async function GET(request: NextRequest) {
  // Demo bypasses auth (public sales demo); live requires a risk role. The
  // demo data source is resolved inside computeLiabilityForecast (DEMO_MODE).
  // The tenant is only resolvable from a session, and demo mode has none — so
  // it is carried out of the guarded branch rather than re-read below.
  let tenantId = '';
  if (!DEMO_MODE) {
    const auth = await requireRiskUser();
    if (!auth.ok) return auth.response;
    tenantId = auth.tenantId;
  }

  const sp = request.nextUrl.searchParams;
  const assetClass: AssetClass = sp.get('assetClass') === 'futures' ? 'futures' : 'forex';
  const horizonDays: 7 | 30 = Number(sp.get('horizonDays')) === 30 ? 30 : 7;

  const overrides: { approvalRate?: number; avgDeductionRate?: number } = {};

  const approvalRateParam = sp.get('approvalRate');
  if (approvalRateParam !== null) {
    const v = Number(approvalRateParam);
    if (Number.isFinite(v)) overrides.approvalRate = Math.min(1, Math.max(0, v));
  }

  const deductionRateParam = sp.get('deductionRate');
  if (deductionRateParam !== null) {
    const v = Number(deductionRateParam);
    if (Number.isFinite(v)) overrides.avgDeductionRate = Math.min(1, Math.max(0, v));
  }

  const forecast = await computeLiabilityForecast({ assetClass, horizonDays, overrides, tenantId });
  return Response.json(forecast);
}
