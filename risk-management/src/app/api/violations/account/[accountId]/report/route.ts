export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { DEMO_MODE } from '@/lib/demo';
import { requireRiskUser } from '@/lib/auth/guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';
import { validationErrorResponse } from '@/lib/api/schemas';
import { createClient } from '@/lib/supabase/server';
import { csvResponse } from '@/lib/export/csv';
import { buildViolationDetail } from '@/lib/mock/builders';
import {
  buildDemoViolationReport,
  buildViolationReport,
  getLatestViolationReport,
  renderAccountViolationsCsv,
  reportOf,
  requestScopedReportDb,
  type AccountViolationReportEntry,
} from '@/lib/reports/violation';

/**
 * GET /api/violations/account/[accountId]/report
 *
 * Every violation on one account as a single CSV: a Summary section with one
 * row per violation and a Trades section keyed by `violation_id`.
 *
 * Missing reports are BUILT before the export rather than skipped, because an
 * export that quietly omits the violations nobody has downloaded yet is worse
 * than no export. The response says exactly how many were built versus reused
 * (`X-Reports-Built` / `X-Reports-Reused`) — the job reports what it did, not
 * what it attempted (see 00024_morning_reports.sql's header).
 */

const accountParamSchema = z.object({
  accountId: z.string().trim().min(1).max(100),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function filenameFor(accountId: string): string {
  return `proprisk-violations-${accountId}.csv`;
}

function withCounts(csv: string, accountId: string, built: number, reused: number): Response {
  const res = csvResponse(filenameFor(accountId), csv);
  res.headers.set('X-Reports-Built', String(built));
  res.headers.set('X-Reports-Reused', String(reused));
  return res;
}

export async function GET(_request: NextRequest, { params }: { params: { accountId: string } }) {
  const parsed = accountParamSchema.safeParse(params);
  if (!parsed.success) return validationErrorResponse(parsed.error);
  const accountParam = parsed.data.accountId;

  // Demo mode builds from the mock dataset and persists nothing, so every
  // report is "built" and none is reused.
  if (DEMO_MODE) {
    const detail = buildViolationDetail(accountParam);
    const entries = (detail.violationBreakdown ?? [])
      .map((v) => {
        const violationId = `${detail.accountId}-${v.type}`;
        const report = buildDemoViolationReport(violationId);
        return report ? { violationId, report } : null;
      })
      .filter((e): e is AccountViolationReportEntry => e !== null);

    return withCounts(renderAccountViolationsCsv(entries), accountParam, entries.length, 0);
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  // Lower than the single-violation limit on purpose: one call here can build
  // many reports, each of which writes a row and an audit-chain entry.
  const rl = await checkRateLimit('violation-report-account', { windowMs: 60_000, maxRequests: 10 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const supabase = await createClient();
    const db = requestScopedReportDb(supabase, auth.tenantId);

    // `accounts.id` is the FK every per-account table uses, but the operator
    // UI routes by the provider-facing login. Accept either; resolve to the
    // internal id before touching violations.
    let internalAccountId = accountParam;
    if (!UUID_RE.test(accountParam)) {
      const { data: accountRow } = await db.from('accounts').eq('login', accountParam).maybeSingle();
      if (!accountRow) return NextResponse.json({ error: 'Account not found' }, { status: 404 });
      internalAccountId = String((accountRow as { id: string }).id);
    }

    const { data: violationRows, error } = await db
      .from('violations')
      .eq('account_id', internalAccountId)
      .order('detected_at', { ascending: false })
      .limit(500);
    if (error) throw error;

    const ids = (Array.isArray(violationRows) ? violationRows : []).map((row) =>
      String((row as { id: string }).id)
    );

    const entries: AccountViolationReportEntry[] = [];
    let built = 0;
    let reused = 0;

    // Sequential on purpose: each miss writes a row and an audit-chain entry,
    // and the chain is serialized anyway. Fanning out would only queue behind
    // the same advisory lock while multiplying the failure surface.
    for (const violationId of ids) {
      const existing = await getLatestViolationReport(auth.tenantId, violationId, db);
      if (existing) {
        reused += 1;
        entries.push({ violationId, report: reportOf(existing) });
        continue;
      }
      const { record, unchanged } = await buildViolationReport({
        tenantId: auth.tenantId,
        violationId,
        actor: auth.actor,
        db,
      });
      if (unchanged) reused += 1;
      else built += 1;
      entries.push({ violationId, report: reportOf(record) });
    }

    return withCounts(renderAccountViolationsCsv(entries), accountParam, built, reused);
  } catch (err) {
    logError('Failed to export account violation reports', err, {
      route: '/api/violations/account/[accountId]/report',
      category: 'database',
    });
    return NextResponse.json({ error: 'Failed to export violation reports' }, { status: 500 });
  }
}
