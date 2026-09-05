import { NextResponse } from 'next/server';
import { runReviewerAgent } from '@/lib/reviewer/agent';
import { logError, cronMetrics } from '@/lib/logging/logger';
import { fanOutToTenants } from '@/app/api/cron/_lib/fanout';

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
    const outcomes = await fanOutToTenants(runReviewerAgent, {
      jobName: 'reviewer',
      concurrency: 3,
    });

    const totals = outcomes.reduce(
      (acc, o) => {
        if (o.ok && o.result) {
          acc.processed += o.result.confirmed + o.result.pending_deduction;
          acc.errors += o.result.errors;
          acc.skipped += o.result.skipped;
        } else {
          acc.errors += 1;
        }
        return acc;
      },
      { processed: 0, errors: 0, skipped: 0 }
    );

    cronMetrics('reviewer', startTime, totals);

    return NextResponse.json({
      message: 'Reviewer agent run complete',
      results: outcomes.map((o) => ({ tenant_id: o.tenant_id, ok: o.ok, ...(o.ok ? o.result : { error: o.error }) })),
    });
  } catch (err) {
    logError('Reviewer cron failed', err, {
      route: '/api/cron/reviewer',
      category: 'cron',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
