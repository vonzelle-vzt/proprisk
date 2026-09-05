export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { DEMO_MODE } from '@/lib/demo';
import { requireRiskUser } from '@/lib/auth/guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';
import { validationErrorResponse } from '@/lib/api/schemas';
import { openDisputeBodySchema, disputesListQuerySchema } from '@/lib/disputes/schemas';
import { openDispute, listDisputes } from '@/lib/disputes/lifecycle';
import { demoListDisputes, demoOpenDispute } from '@/lib/disputes/demo';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const parsed = disputesListQuerySchema.safeParse({
    status: params.get('status') || undefined,
    subjectType: params.get('subjectType') || undefined,
  });
  if (!parsed.success) return validationErrorResponse(parsed.error);

  if (DEMO_MODE) {
    return NextResponse.json({ data: demoListDisputes(parsed.data) });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('disputes-list', { windowMs: 60_000, maxRequests: 60 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const data = await listDisputes(auth.tenantId, parsed.data);
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
  } catch (err) {
    logError('Failed to list disputes', err, { route: '/api/disputes', category: 'database' });
    return NextResponse.json({ error: 'Failed to list disputes' }, { status: 500 });
  }
}

/**
 * Open a dispute from the firm's side, on a trader's behalf — there is no
 * trader-facing surface yet (docs/HOW-IT-WORKS.md §6 lists that as the
 * highest-leverage thing to build next), so a risk-team member files the
 * case and records the trader's statement.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = openDisputeBodySchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  if (DEMO_MODE) {
    return NextResponse.json({ data: demoOpenDispute(parsed.data) }, { status: 201 });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('disputes-open', { windowMs: 60_000, maxRequests: 20 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const dispute = await openDispute({
      tenantId: auth.tenantId,
      subjectType: parsed.data.subjectType,
      subjectId: parsed.data.subjectId,
      accountId: parsed.data.accountId,
      raisedBy: parsed.data.raisedBy,
      traderStatement: parsed.data.traderStatement,
      actor: auth.actor,
      actorUserId: auth.user.id,
    });
    return NextResponse.json({ data: dispute }, { status: 201 });
  } catch (err) {
    logError('Failed to open dispute', err, { route: '/api/disputes', category: 'database' });
    return NextResponse.json({ error: 'Failed to open dispute' }, { status: 500 });
  }
}
