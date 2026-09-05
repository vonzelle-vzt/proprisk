export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { DEMO_MODE } from '@/lib/demo';
import { requireRiskManager, requireRiskUser } from '@/lib/auth/guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';
import { validationErrorResponse, violationIdParamSchema } from '@/lib/api/schemas';
import { createClient } from '@/lib/supabase/server';
import { csvResponse } from '@/lib/export/csv';
import {
  buildDemoViolationReport,
  buildViolationReport,
  getLatestViolationReport,
  renderViolationReportCsv,
  renderViolationReportPdf,
  reportOf,
  requestScopedReportDb,
  ViolationNotFoundError,
  type ViolationReport,
} from '@/lib/reports/violation';

/**
 * GET  /api/violations/[id]/report?format=pdf|csv|json
 * POST /api/violations/[id]/report            (regenerate)
 *
 * The per-violation decision record (docs/HOW-IT-WORKS.md §2 Flow 3). GET
 * serves the report the firm already holds and generates one on first ask;
 * POST re-runs the assembly against today's rows, which a risk manager needs
 * after a deduction is executed or a dispute is resolved.
 *
 * Reads go through the REQUEST-SCOPED Supabase client, so RLS applies and a
 * caller can only ever reach their own tenant's violations — the tenant claim
 * is not a filter this route applies, it is a predicate the database enforces.
 */

const formatQuerySchema = z.object({
  format: z.enum(['pdf', 'csv', 'json']).default('json'),
});

function pdfFilename(id: string): string {
  return `proprisk-violation-${id}.pdf`;
}

function csvFilenameFor(id: string): string {
  return `proprisk-violation-${id}.csv`;
}

function pdfResponse(pdf: Buffer, id: string): Response {
  return new Response(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${pdfFilename(id)}"`,
      'Cache-Control': 'no-store',
    },
  });
}

async function respond(report: ViolationReport, format: string, id: string): Promise<Response> {
  if (format === 'pdf') return pdfResponse(await renderViolationReportPdf(report), id);
  if (format === 'csv') return csvResponse(csvFilenameFor(id), renderViolationReportCsv(report));
  return NextResponse.json({ data: report }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const parsedQuery = formatQuerySchema.safeParse({
    format: request.nextUrl.searchParams.get('format') ?? undefined,
  });
  if (!parsedQuery.success) return validationErrorResponse(parsedQuery.error);
  const { format } = parsedQuery.data;

  // Demo mode has no writable database: the report is assembled from the mock
  // dataset and never persisted. Ids there are `${accountId}-${type}`, not
  // uuids, so the uuid param check belongs on the live path only.
  if (DEMO_MODE) {
    const demo = buildDemoViolationReport(params.id);
    if (!demo) return NextResponse.json({ error: 'Violation not found' }, { status: 404 });
    return respond(demo, format, params.id);
  }

  const parsedParams = violationIdParamSchema.safeParse(params);
  if (!parsedParams.success) return validationErrorResponse(parsedParams.error);
  const violationId = parsedParams.data.id;

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('violation-report', { windowMs: 60_000, maxRequests: 30 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const supabase = await createClient();
    const db = requestScopedReportDb(supabase, auth.tenantId);

    const existing = await getLatestViolationReport(auth.tenantId, violationId, db);
    if (existing) return respond(reportOf(existing), format, violationId);

    const { record } = await buildViolationReport({
      tenantId: auth.tenantId,
      violationId,
      actor: auth.actor,
      db,
    });
    return respond(reportOf(record), format, violationId);
  } catch (err) {
    if (err instanceof ViolationNotFoundError) {
      return NextResponse.json({ error: 'Violation not found' }, { status: 404 });
    }
    logError('Failed to build violation report', err, {
      route: '/api/violations/[id]/report',
      category: 'database',
    });
    return NextResponse.json({ error: 'Failed to build violation report' }, { status: 500 });
  }
}

/**
 * Regenerate. Always re-runs the assembly — but the write is idempotent by
 * content hash, so a rebuild that finds nothing changed returns the EXISTING
 * row rather than a duplicate, and says so via `unchanged`. That distinction
 * is the point: "I regenerated it and nothing moved" is a different answer
 * from "I regenerated it", and a report generator that cannot tell them apart
 * is the silent-success failure this codebase keeps producing.
 *
 * Restricted to risk_manager|admin: regenerating writes a row and an audit
 * entry naming the human who did it.
 */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  if (DEMO_MODE) {
    const demo = buildDemoViolationReport(params.id);
    if (!demo) return NextResponse.json({ error: 'Violation not found' }, { status: 404 });
    return NextResponse.json(
      { data: demo, unchanged: true },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const parsedParams = violationIdParamSchema.safeParse(params);
  if (!parsedParams.success) return validationErrorResponse(parsedParams.error);
  const violationId = parsedParams.data.id;

  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('violation-report-rebuild', { windowMs: 60_000, maxRequests: 10 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const supabase = await createClient();
    const db = requestScopedReportDb(supabase, auth.tenantId);

    const { record, unchanged } = await buildViolationReport({
      tenantId: auth.tenantId,
      violationId,
      actor: auth.actor,
      db,
    });

    return NextResponse.json(
      { data: reportOf(record), unchanged },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    if (err instanceof ViolationNotFoundError) {
      return NextResponse.json({ error: 'Violation not found' }, { status: 404 });
    }
    logError('Failed to regenerate violation report', err, {
      route: '/api/violations/[id]/report',
      category: 'database',
    });
    return NextResponse.json({ error: 'Failed to regenerate violation report' }, { status: 500 });
  }
}
