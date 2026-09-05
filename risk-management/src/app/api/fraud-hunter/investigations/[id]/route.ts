export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import {
  getFraudInvestigation,
  updateInvestigationStatus,
} from '@/lib/fraud-hunter/persistence';
import { getDemoInvestigation } from '@/lib/fraud-hunter/demo';
import { requireRiskUser } from '@/lib/auth/guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';
import { DEMO_MODE } from '@/lib/demo';
import type { FraudStatus } from '@/types/fraud';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;

  if (DEMO_MODE) {
    const data = getDemoInvestigation(id);
    if (!data) {
      return NextResponse.json({ error: 'Investigation not found' }, { status: 404 });
    }
    return NextResponse.json({ data }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('fraud-investigation-get', { windowMs: 60_000, maxRequests: 30 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const data = await getFraudInvestigation(auth.tenantId, id);

    if (!data) {
      return NextResponse.json({ error: 'Investigation not found' }, { status: 404 });
    }

    return NextResponse.json({ data }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (err) {
    logError(`Failed to fetch fraud investigation ${id}`, err, {
      route: `/api/fraud-hunter/investigations/${id}`,
      category: 'database',
      tenant_id: auth.tenantId,
    });
    return NextResponse.json(
      { error: 'Failed to fetch fraud investigation' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  if (DEMO_MODE) {
    return NextResponse.json({ error: 'Not available in demo mode' }, { status: 403 });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('fraud-investigation-update', { windowMs: 60_000, maxRequests: 20 });
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id } = params;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { status, resolved_by, resolution_notes } = body;

  if (!status || typeof status !== 'string') {
    return NextResponse.json(
      { error: 'status is required and must be a string' },
      { status: 400 }
    );
  }

  try {
    const data = await updateInvestigationStatus(auth.tenantId, id, status as FraudStatus, resolved_by, resolution_notes);

    return NextResponse.json({ data });
  } catch (err) {
    logError(`Failed to update fraud investigation ${id}`, err, {
      route: `/api/fraud-hunter/investigations/${id}`,
      category: 'database',
      tenant_id: auth.tenantId,
    });
    return NextResponse.json(
      { error: 'Failed to update fraud investigation' },
      { status: 500 }
    );
  }
}
