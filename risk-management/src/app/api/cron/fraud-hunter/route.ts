import { NextResponse } from 'next/server';
import { runFraudHunterScan } from '@/lib/fraud-hunter/agent';
import { fanOutToTenants } from '@/app/api/cron/_lib/fanout';
import { logError, cronMetrics } from '@/lib/logging/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startTime = Date.now();

  try {
    const outcomes = await fanOutToTenants(
      (tenantId) => runFraudHunterScan(tenantId),
      { jobName: 'fraud-hunter', concurrency: 3 }
    );

    const totals = outcomes.reduce(
      (acc, o) => {
        if (o.ok && o.result) {
          acc.new_investigations += o.result.new_investigations;
          acc.total_findings += o.result.total_findings;
          acc.persistence_errors += o.result.persistence_errors;
        } else {
          acc.tenant_failures += 1;
        }
        return acc;
      },
      { new_investigations: 0, total_findings: 0, persistence_errors: 0, tenant_failures: 0 }
    );

    cronMetrics('fraud-hunter', startTime, {
      processed: totals.new_investigations,
      errors: totals.persistence_errors + totals.tenant_failures,
    });

    return NextResponse.json({
      message: 'Fraud hunter scan complete',
      results: {
        ...totals,
        tenants: outcomes.map((o) => ({
          tenant_id: o.tenant_id,
          ok: o.ok,
          ...(o.ok ? o.result : { error: o.error }),
        })),
      },
    });
  } catch (err) {
    logError('Fraud hunter cron failed', err, {
      route: '/api/cron/fraud-hunter',
      category: 'cron',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
