export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getFraudInvestigations } from '@/lib/fraud-hunter/persistence';
import { getDemoInvestigations } from '@/lib/fraud-hunter/demo';
import { requireRiskUser } from '@/lib/auth/guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';
import { DEMO_MODE } from '@/lib/demo';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const status = params.get('status') || undefined;
  const fraud_type = params.get('fraud_type') || undefined;
  const severity = params.get('severity') || undefined;
  const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 200);
  const offset = Math.max(Number(params.get('offset')) || 0, 0);

  if (DEMO_MODE) {
    const data = getDemoInvestigations({
      status: status ? (status.split(',') as any) : undefined,
      fraud_type: fraud_type ? (fraud_type.split(',') as any) : undefined,
      severity: severity ? severity.split(',') : undefined,
      limit,
      offset,
    });
    return NextResponse.json({ data }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('fraud-investigations', { windowMs: 60_000, maxRequests: 30 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const data = await getFraudInvestigations(auth.tenantId, {
      status: status ? status.split(',') as any : undefined,
      fraud_type: fraud_type ? fraud_type.split(',') as any : undefined,
      severity: severity ? severity.split(',') : undefined,
      limit,
      offset,
    });

    return NextResponse.json({ data }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (err) {
    logError('Failed to fetch fraud investigations', err, {
      route: '/api/fraud-hunter/investigations',
      category: 'database',
      tenant_id: auth.tenantId,
    });
    return NextResponse.json(
      { error: 'Failed to fetch fraud investigations' },
      { status: 500 }
    );
  }
}
