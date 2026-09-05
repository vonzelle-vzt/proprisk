import { NextResponse } from 'next/server';
import { dequeueViolationJob, getViolationQueueDepth, isViolationQueueEnabled } from '@/lib/queue/violations';
import { processViolationJob } from '@/lib/violations/worker';
import { logAuditEvent } from '@/lib/deductions/audit';
import { fanOutToTenants } from '@/app/api/cron/_lib/fanout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_JOBS_PER_RUN = 200;

async function processTenantQueue(tenantId: string) {
  let processed = 0;
  let succeeded = 0;

  for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
    const job = await dequeueViolationJob(tenantId);
    if (!job) break;
    processed++;
    if (await processViolationJob(job, tenantId)) succeeded++;
  }

  const queueDepth = await getViolationQueueDepth(tenantId);
  return { processed, succeeded, failed: processed - succeeded, queue_depth: queueDepth };
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isViolationQueueEnabled()) {
    return NextResponse.json({ message: 'Queue is not configured' }, { status: 200 });
  }

  // Each tenant's queue (queue:violations:pending:<tenantId>) is drained
  // independently — one tenant's backlog cannot delay another's, and a
  // failure draining one tenant's queue does not stop the rest.
  const outcomes = await fanOutToTenants(processTenantQueue, {
    jobName: 'process-violations',
    concurrency: 3,
  });

  const totals = outcomes.reduce(
    (acc, o) => {
      if (o.ok && o.result) {
        acc.processed += o.result.processed;
        acc.succeeded += o.result.succeeded;
        acc.failed += o.result.failed;
        acc.queue_depth += o.result.queue_depth;
      } else {
        acc.tenant_errors++;
      }
      return acc;
    },
    { processed: 0, succeeded: 0, failed: 0, queue_depth: 0, tenant_errors: 0 }
  );

  const result = {
    ...totals,
    tenants: outcomes.map((o) => ({
      tenant_id: o.tenant_id,
      ok: o.ok,
      ...(o.ok ? o.result : { error: o.error }),
    })),
  };

  await logAuditEvent({
    action_type: 'cron_process_violations',
    entity_type: 'system',
    entity_id: 'cron',
    performed_by: 'system',
    details: result,
  });

  return NextResponse.json({ message: 'Violation queue processing complete', results: result });
}
