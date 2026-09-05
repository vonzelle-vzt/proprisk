export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { DEMO_MODE } from '@/lib/demo';
import { requireRiskUser } from '@/lib/auth/guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';
import { computeOverturnRateByRule } from '@/lib/disputes/lifecycle';
import { demoOverturnRateByRule } from '@/lib/disputes/demo';

/**
 * Per-rule overturn rate — how often the firm's own dispute resolution
 * reverses its original decision, broken out by the rule that produced it.
 * docs/HOW-IT-WORKS.md §6.4: "the most useful number this feature can
 * produce and nobody else in the market shows it."
 */
export async function GET() {
  if (DEMO_MODE) {
    return NextResponse.json({ data: demoOverturnRateByRule() });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('disputes-overturn-rate', { windowMs: 60_000, maxRequests: 30 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const data = await computeOverturnRateByRule(auth.tenantId);
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
  } catch (err) {
    logError('Failed to compute dispute overturn rate', err, {
      route: '/api/disputes/overturn-rate',
      category: 'database',
    });
    return NextResponse.json({ error: 'Failed to compute overturn rate' }, { status: 500 });
  }
}
