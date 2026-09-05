export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { DEMO_MODE } from '@/lib/demo';
import { requireRiskUser } from '@/lib/auth/guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';
import { getDispute } from '@/lib/disputes/lifecycle';
import { demoGetDispute } from '@/lib/disputes/demo';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;

  if (DEMO_MODE) {
    const dispute = demoGetDispute(id);
    if (!dispute) return NextResponse.json({ error: 'Dispute not found' }, { status: 404 });
    return NextResponse.json({ data: dispute });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('disputes-get', { windowMs: 60_000, maxRequests: 60 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const dispute = await getDispute(auth.tenantId, id);
    if (!dispute) return NextResponse.json({ error: 'Dispute not found' }, { status: 404 });
    return NextResponse.json({ data: dispute });
  } catch (err) {
    logError(`Failed to fetch dispute ${id}`, err, { route: `/api/disputes/${id}`, category: 'database' });
    return NextResponse.json({ error: 'Failed to fetch dispute' }, { status: 500 });
  }
}
