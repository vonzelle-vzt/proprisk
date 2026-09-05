import { NextResponse } from 'next/server';
import { expireStaleRecommendations } from '@/lib/enforcement/queue-manager';
import { autoEscalate } from '@/lib/enforcement/escalation';
import { logError, cronMetrics } from '@/lib/logging/logger';
import { fanOutToTenants } from '@/app/api/cron/_lib/fanout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function enforceForTenant(tenantId: string) {
  const expired = await expireStaleRecommendations(tenantId);
  const escalated = await autoEscalate(tenantId);
  return { expired, escalated };
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startTime = Date.now();

  try {
    const outcomes = await fanOutToTenants(enforceForTenant, {
      jobName: 'enforce',
      concurrency: 3,
    });

    const totals = outcomes.reduce(
      (acc, o) => {
        if (o.ok && o.result) {
          acc.expired += o.result.expired;
          acc.escalated += o.result.escalated;
        } else {
          acc.errors++;
        }
        return acc;
      },
      { expired: 0, escalated: 0, errors: 0 }
    );

    const results = {
      ...totals,
      tenants: outcomes.map((o) => ({
        tenant_id: o.tenant_id,
        ok: o.ok,
        ...(o.ok ? o.result : { error: o.error }),
      })),
    };

    cronMetrics('enforce', startTime, {
      processed: totals.expired + totals.escalated,
      errors: totals.errors,
    });

    return NextResponse.json({
      message: 'Enforcement cron complete',
      results,
    });
  } catch (err) {
    logError('Enforcement cron failed', err, {
      route: '/api/cron/enforce',
      category: 'cron',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
