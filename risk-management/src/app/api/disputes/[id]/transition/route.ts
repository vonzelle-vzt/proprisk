export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { DEMO_MODE } from '@/lib/demo';
import { requireRiskUser, requireRiskManager } from '@/lib/auth/guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';
import { validationErrorResponse } from '@/lib/api/schemas';
import { disputeTransitionBodySchema } from '@/lib/disputes/schemas';
import { transitionDispute, InvalidDisputeTransitionError } from '@/lib/disputes/lifecycle';
import { demoTransitionDispute } from '@/lib/disputes/demo';
import { TERMINAL_STATUSES } from '@/lib/disputes/types';

/**
 * Moves a dispute forward: `under_review` is a working-queue move (any risk
 * user); upheld/overturned/withdrawn is a resolution that reverses a money
 * decision, so it requires `requireRiskManager()` and a written resolution —
 * overturned is a real outcome here, not a status label (docs/HOW-IT-WORKS.md
 * §6.4).
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = disputeTransitionBodySchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);
  const { status, resolution } = parsed.data;
  const isTerminal = (TERMINAL_STATUSES as string[]).includes(status);

  if (DEMO_MODE) {
    return NextResponse.json({ data: demoTransitionDispute(id, status, resolution, 'Demo Risk Manager') });
  }

  const auth = isTerminal ? await requireRiskManager() : await requireRiskUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('disputes-transition', { windowMs: 60_000, maxRequests: 30 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const dispute = await transitionDispute({
      tenantId: auth.tenantId,
      disputeId: id,
      status,
      resolution,
      actor: auth.actor,
      actorUserId: auth.user.id,
    });
    return NextResponse.json({ data: dispute });
  } catch (err) {
    if (err instanceof InvalidDisputeTransitionError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    logError(`Failed to transition dispute ${id}`, err, {
      route: `/api/disputes/${id}/transition`,
      category: 'database',
    });
    return NextResponse.json({ error: 'Failed to transition dispute' }, { status: 500 });
  }
}
