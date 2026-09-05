export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { batchDecision } from '@/lib/enforcement/queue-manager';
import { requireRiskManager } from '@/lib/auth/guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';
import { DEMO_MODE } from '@/lib/demo';

export async function POST(request: NextRequest) {
  if (DEMO_MODE) {
    const body = await request.json().catch(() => ({}));
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    return NextResponse.json({ ok: true, demo: true, updated: ids.length, results: ids.map((id: string) => ({ id, ok: true })) });
  }
  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('enforcement-batch', { windowMs: 60_000, maxRequests: 10 });
  if (!rl.allowed) return rateLimitResponse(rl);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { recommendation_ids, decision, decided_by, notes } = body;

  if (!Array.isArray(recommendation_ids) || recommendation_ids.length === 0) {
    return NextResponse.json(
      { error: 'recommendation_ids must be a non-empty array' },
      { status: 400 }
    );
  }

  if (!decision || !['approved', 'rejected'].includes(decision)) {
    return NextResponse.json(
      { error: 'decision must be "approved" or "rejected"' },
      { status: 400 }
    );
  }

  if (!decided_by || typeof decided_by !== 'string') {
    return NextResponse.json(
      { error: 'decided_by is required and must be a string' },
      { status: 400 }
    );
  }

  try {
    const result = await batchDecision({ recommendation_ids, decision, decided_by, notes }, auth.tenantId);
    return NextResponse.json({ data: result });
  } catch (err) {
    logError('Failed to process batch enforcement decision', err, {
      route: '/api/enforcement/batch',
      category: 'database',
    });
    return NextResponse.json(
      { error: 'Failed to process batch decision' },
      { status: 500 }
    );
  }
}
