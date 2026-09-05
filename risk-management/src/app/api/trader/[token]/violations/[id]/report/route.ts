export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { DEMO_MODE } from '@/lib/demo';
import { tenantDb } from '@/lib/db/tenant-scoped';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';
import { validationErrorResponse } from '@/lib/api/schemas';
import { csvResponse } from '@/lib/export/csv';
import { DEMO_TRADER_TOKEN } from '@/lib/trader/demo';
import { verifyTraderToken } from '@/lib/trader/tokens';
import {
  buildDemoViolationReport,
  buildViolationReport,
  getLatestViolationReport,
  renderViolationReportCsv,
  renderViolationReportPdf,
  reportOf,
  ViolationNotFoundError,
  type ViolationReport,
} from '@/lib/reports/violation';

/**
 * GET /api/trader/[token]/violations/[id]/report?format=pdf|csv
 *
 * The "Full decision record: [link]" at the bottom of the trader notice
 * (docs/HOW-IT-WORKS.md §2 Flow 3). Public by prefix — traders hold no
 * Supabase session, so the token in the path is the entire authentication
 * boundary and is re-verified on every request.
 *
 * Two properties this route must not lose:
 *
 *  - The tenant and account come from `verifyTraderToken`, NEVER from the
 *    URL. There is no parameter here a caller could substitute to reach a
 *    different account or a different firm.
 *  - Every failure is an undifferentiated 404. A 403 on someone else's
 *    violation id would confirm that the id exists, which turns a link into
 *    an enumeration oracle. "Belongs to another account" and "never existed"
 *    must be indistinguishable from outside.
 *
 * `tenantDb` (not the request-scoped client) is the right handle here for the
 * same reason `src/app/api/trader/[token]/route.ts` uses it: a trader request
 * carries no tenant claim, so there is nothing for RLS to key off — the token
 * is the proof, and the wrapper binds every query to the single tenant it
 * resolved to.
 */

const querySchema = z.object({
  format: z.enum(['pdf', 'csv']).default('pdf'),
});

const NOT_FOUND = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

function respond(report: ViolationReport, format: 'pdf' | 'csv', id: string): Promise<Response> | Response {
  if (format === 'csv') {
    return csvResponse(`proprisk-violation-${id}.csv`, renderViolationReportCsv(report));
  }
  return renderViolationReportPdf(report).then(
    (pdf) =>
      new Response(new Uint8Array(pdf), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="proprisk-violation-${id}.pdf"`,
          'Cache-Control': 'no-store',
        },
      })
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: { token: string; id: string } }
) {
  const parsed = querySchema.safeParse({
    format: request.nextUrl.searchParams.get('format') ?? undefined,
  });
  if (!parsed.success) return validationErrorResponse(parsed.error);

  // The service-role client `verifyTraderToken` needs is structurally disabled
  // in demo mode. Only the fixed demo token resolves to anything, and the
  // report is assembled straight from the mock dataset — same chokepoint as
  // /api/violations/[id]/report's DEMO_MODE branch — never Supabase.
  if (DEMO_MODE) {
    if (params.token !== DEMO_TRADER_TOKEN) return NOT_FOUND();
    const demo = buildDemoViolationReport(params.id);
    if (!demo) return NOT_FOUND();
    return respond(demo, parsed.data.format, params.id);
  }

  const verified = await verifyTraderToken(params.token);
  if (!verified) return NOT_FOUND();

  const rl = await checkRateLimit(`violation-report-trader:${verified.tokenId}`, {
    windowMs: 60_000,
    maxRequests: 20,
  });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const db = tenantDb(verified.tenantId, 'traderViolationReport');

    // The ownership check. Scoped to the token's tenant by `tenantDb` and to
    // the token's account by this filter; a violation belonging to any other
    // account — or any other firm — simply does not come back.
    const { data: violationRow } = await db
      .from('violations')
      .eq('id', params.id)
      .eq('account_id', verified.accountId)
      .maybeSingle();
    if (!violationRow) return NOT_FOUND();

    const existing = await getLatestViolationReport(verified.tenantId, params.id, db);
    if (existing) return respond(reportOf(existing), parsed.data.format, params.id);

    // A trader may be the first to ask for the record. Generating it is a
    // read-shaped action (it asserts nothing new), and the audit entry names
    // the trader link rather than a staff member, so the chain does not
    // mis-attribute the generation to the firm.
    const { record } = await buildViolationReport({
      tenantId: verified.tenantId,
      violationId: params.id,
      actor: `trader_link:${verified.tokenId}`,
      db,
    });
    return respond(reportOf(record), parsed.data.format, params.id);
  } catch (err) {
    if (err instanceof ViolationNotFoundError) return NOT_FOUND();
    logError('Failed to build trader violation report', err, {
      route: '/api/trader/[token]/violations/[id]/report',
      category: 'database',
    });
    return NextResponse.json({ error: 'Failed to build report' }, { status: 500 });
  }
}
