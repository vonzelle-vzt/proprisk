export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getAccountEnforcementHistory } from '@/lib/enforcement/queue-manager';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';

export async function GET(
  request: NextRequest,
  { params }: { params: { accountId: string } }
) {
  const rl = await checkRateLimit('enforcement-history', { windowMs: 60_000, maxRequests: 30 });
  if (!rl.allowed) return rateLimitResponse(rl);

  const { accountId } = params;

  if (!accountId) {
    return NextResponse.json({ error: 'accountId is required' }, { status: 400 });
  }

  try {
    const data = await getAccountEnforcementHistory(accountId);

    return NextResponse.json({ data }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (err) {
    logError(`Failed to fetch enforcement history for ${accountId}`, err, {
      route: `/api/enforcement/history/${accountId}`,
      category: 'database',
      account_id: accountId,
    });
    return NextResponse.json(
      { error: 'Failed to fetch enforcement history' },
      { status: 500 }
    );
  }
}
