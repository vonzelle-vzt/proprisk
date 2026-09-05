export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getEnforcementQueue } from '@/lib/enforcement/queue-manager';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';
import { DEMO_MODE, assetClassFromRequest } from '@/lib/demo';
import { buildEnforcementQueue } from '@/lib/mock/builders';

export async function GET(request: NextRequest) {
  if (DEMO_MODE) return NextResponse.json(buildEnforcementQueue(assetClassFromRequest(request)));
  const rl = await checkRateLimit('enforcement-queue', { windowMs: 60_000, maxRequests: 30 });
  if (!rl.allowed) return rateLimitResponse(rl);

  const params = request.nextUrl.searchParams;
  const status = params.get('status') ? params.get('status')!.split(',') : undefined;
  const escalation_level = params.get('escalation_level')
    ? params.get('escalation_level')!.split(',')
    : undefined;
  const violation_type = params.get('violation_type') ? params.get('violation_type')!.split(',') : undefined;
  const account_id = params.get('account_id') || undefined;
  const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 200);
  const offset = Math.max(Number(params.get('offset')) || 0, 0);

  try {
    const data = await getEnforcementQueue({
      status,
      escalation_level,
      violation_type,
      account_id,
      limit,
      offset,
    });

    return NextResponse.json({ data }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (err) {
    logError('Failed to fetch enforcement queue', err, {
      route: '/api/enforcement/queue',
      category: 'database',
    });
    return NextResponse.json({ error: 'Failed to fetch enforcement queue' }, { status: 500 });
  }
}
