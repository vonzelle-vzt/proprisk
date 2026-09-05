export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { runFraudHunterScan } from '@/lib/fraud-hunter/agent';
import { requireRiskUser } from '@/lib/auth/guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError, logInfo } from '@/lib/logging/logger';
import { DEMO_MODE } from '@/lib/demo';
import { MOCK_NETWORK_CLUSTERS } from '@/lib/mock/dataset.network';

export async function POST(request: NextRequest) {
  if (DEMO_MODE) {
    // No live scan to run against mock data — return a plausible no-op
    // result (findings = the rings already surfaced in the mock dataset)
    // instead of 403ing, so the "Run Scan" button works in the sales demo.
    return NextResponse.json({ data: { demo: true, findings: MOCK_NETWORK_CLUSTERS.length } });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('fraud-scan', { windowMs: 60_000, maxRequests: 2 });
  if (!rl.allowed) return rateLimitResponse(rl);

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const detectors = Array.isArray(body.detectors) ? body.detectors : undefined;
  const lookback_hours =
    typeof body.lookback_hours === 'number' && body.lookback_hours > 0
      ? body.lookback_hours
      : undefined;

  try {
    logInfo('Manual fraud scan triggered', {
      route: '/api/fraud-hunter/scan',
      category: 'internal',
    });

    const result = await runFraudHunterScan(auth.tenantId, { detectors, lookbackHours: lookback_hours });

    return NextResponse.json({ data: result });
  } catch (err) {
    logError('Failed to run fraud scan', err, {
      route: '/api/fraud-hunter/scan',
      category: 'internal',
    });
    return NextResponse.json({ error: 'Failed to run fraud scan' }, { status: 500 });
  }
}
