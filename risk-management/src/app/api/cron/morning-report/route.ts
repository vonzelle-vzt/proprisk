import { NextResponse } from 'next/server';
import { generateMorningReportData, formatMorningReport } from '@/lib/ai/morning-report';
import { tenantDb } from '@/lib/db/tenant-scoped';
import { fanOutToTenants } from '@/app/api/cron/_lib/fanout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function generateForTenant(tenantId: string) {
  const reportData = await generateMorningReportData(tenantId);
  const summary = formatMorningReport(reportData);

  // `morning_reports` did not exist in any migration until 00024, so every
  // insert here failed and this function returned `stored: false` while the
  // reader silently regenerated live — the feature looked like it worked and
  // persisted nothing. The table now exists, tenant-scoped, and tenantDb()
  // stamps tenant_id rather than folding it into the JSON payload.
  let stored = false;
  let storeError: string | null = null;
  try {
    const { error } = await tenantDb(tenantId, 'morning-report cron').insert('morning_reports', {
      summary,
      data: reportData,
    });
    stored = !error;
    if (error) {
      storeError = error.message;
      console.error('Failed to store morning report:', error.message);
    }
  } catch (dbError) {
    storeError = dbError instanceof Error ? dbError.message : String(dbError);
    console.error('Supabase storage error:', dbError);
  }

  return { stored, storeError, data: reportData, summary };
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const outcomes = await fanOutToTenants(generateForTenant, {
      jobName: 'morning-report',
      concurrency: 3,
    });

    return NextResponse.json({
      message: 'Morning report generated',
      results: outcomes.map((o) => ({ tenant_id: o.tenant_id, ok: o.ok, ...(o.ok ? o.result : { error: o.error }) })),
    });
  } catch (error: any) {
    console.error('Morning report generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate morning report' },
      { status: 500 }
    );
  }
}
