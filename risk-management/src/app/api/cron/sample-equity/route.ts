import { NextResponse } from 'next/server';
import { fanOutToTenants } from '@/app/api/cron/_lib/fanout';
import { sampleTenant } from '@/lib/ingest/sample';
import { logError, cronMetrics } from '@/lib/logging/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Pull-path equity sampling. Per tenant, per account: pulls balance/equity
 * from that tenant's configured provider adapter(s) via `getBalanceEquity`
 * and writes it to `equity_snapshots` (supabase/migrations/00022). This is
 * what makes `drawdown.mode = trailing_intraday` and
 * `daily_loss.basis = highest_equity_of_day` evaluable instead of
 * permanently `indeterminate` — see docs/HOW-IT-WORKS.md §6.2 and
 * src/lib/ingest/sample.ts for the interval/concurrency trade-offs.
 *
 * Registered in vercel.json's `crons` list (every five minutes); that file is outside
 * this task's FILES_IN_SCOPE. Someone needs to add an entry (e.g. every 5
 * minutes, matching EQUITY_SAMPLE_INTERVAL_SECONDS' default) before this
 * runs on a schedule; until then it's callable directly with CRON_SECRET.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startTime = Date.now();

  try {
    const outcomes = await fanOutToTenants(sampleTenant, {
      jobName: 'sample-equity',
      concurrency: 3,
    });

    const totals = outcomes.reduce(
      (acc, o) => {
        if (o.ok && o.result) {
          acc.accounts_considered += o.result.accounts_considered;
          acc.sampled += o.result.sampled;
          acc.no_provider += o.result.no_provider;
          acc.provider_errors += o.result.provider_errors;
        } else {
          acc.tenant_failures += 1;
        }
        return acc;
      },
      { accounts_considered: 0, sampled: 0, no_provider: 0, provider_errors: 0, tenant_failures: 0 }
    );

    cronMetrics('sample-equity', startTime, {
      processed: totals.sampled,
      errors: totals.provider_errors + totals.tenant_failures,
    });

    return NextResponse.json({
      message: 'Equity sampling complete',
      totals,
      tenants: outcomes.map((o) => ({
        tenant_id: o.tenant_id,
        ok: o.ok,
        ...(o.ok ? o.result : { error: o.error }),
      })),
    });
  } catch (error: any) {
    logError('sample-equity cron failed', error, { category: 'cron' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
