export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRiskManager, requireRiskUser } from '@/lib/auth/guards';
import { tenantDb } from '@/lib/db/tenant-scoped';
import { runBacktest } from '@/lib/rulepack/backtest';
import { packVersionKey } from '@/lib/rulepack/store';
import { findDemoPack, findDemoBacktestHistory, runDemoBacktest } from '@/lib/rulepack/demo';
import { DEMO_MODE } from '@/lib/demo';
import { runBacktestBodySchema } from '../../_lib/schemas';
import { rulePackErrorResponse } from '../../_lib/errors';
import { findPack } from '../../_lib/get-pack';

const idParamSchema = z.object({ id: z.string().uuid() });

/**
 * Shadow-mode backtest for one pack version.
 *
 * There is no live-provider-history adapter yet (see the note on
 * `runBacktestBodySchema`), so the caller supplies the account/trade history
 * to replay directly. This route's job is: run the SAME `evaluateRulePack`
 * path production uses (via `runBacktest`), then persist the run as a
 * first-class record — `activate()` reads the latest completed run for this
 * pack id, so a run that is never written is a run that can never unblock
 * activation.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  // Demo ids ("demo-apex-futures") are not UUIDs and the demo pack is never
  // asked to bring its own history, so this branch runs before both the id
  // and body schemas below — those are live-mode-only shapes.
  if (DEMO_MODE) {
    const pack = findDemoPack(params.id);
    if (!pack) return NextResponse.json({ error: 'Rule pack not found' }, { status: 404 });

    let body: unknown = undefined;
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
    const parsedBody = runBacktestBodySchema.safeParse(body);
    const accountInputs = parsedBody.success ? parsedBody.data.account_inputs : undefined;

    const result = runDemoBacktest(params.id, accountInputs);
    if (!result) return NextResponse.json({ error: 'Rule pack not found' }, { status: 404 });

    return NextResponse.json({
      demo: true,
      data: { backtest_run_id: `demo-backtest-${params.id}`, ...result },
    });
  }

  const parsedParams = idParamSchema.safeParse(params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: 'Invalid rule pack id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = runBacktestBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

  try {
    const pack = await findPack(auth.tenantId, parsedParams.data.id);
    if (!pack) return NextResponse.json({ error: 'Rule pack not found' }, { status: 404 });

    const result = runBacktest(
      pack.pack,
      packVersionKey(pack),
      parsed.data.account_inputs,
      parsed.data.provider_reported
    );

    const db = tenantDb(auth.tenantId, 'POST /api/rulepack/[id]/backtest');
    const { data: inserted, error } = await db
      .insert('backtest_runs', {
        rule_pack_id: pack.id,
        rule_pack_version: pack.version,
        status: 'complete',
        window_start: parsed.data.window_start,
        window_end: parsed.data.window_end,
        accounts_evaluated: result.accountsEvaluated,
        engine_breaches: result.engineBreaches,
        provider_breaches: result.providerBreaches,
        reconciliation_json: result.reconciliation,
        skipped_json: result.skipped,
        created_by: auth.user.id,
        completed_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json(
      { data: { backtest_run_id: (inserted as { id: string }).id, ...result } },
      { status: 201 }
    );
  } catch (err) {
    return rulePackErrorResponse(err, 'POST /api/rulepack/[id]/backtest');
  }
}

/** Backtest run history for one pack, most recent first. */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  if (DEMO_MODE) {
    if (!findDemoPack(params.id)) return NextResponse.json({ data: [], demo: true });
    return NextResponse.json({ data: findDemoBacktestHistory(params.id), demo: true });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const parsedParams = idParamSchema.safeParse(params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: 'Invalid rule pack id' }, { status: 400 });
  }

  try {
    const db = tenantDb(auth.tenantId, 'GET /api/rulepack/[id]/backtest');
    const { data, error } = await db
      .select(
        'backtest_runs',
        'id, status, window_start, window_end, accounts_evaluated, engine_breaches, provider_breaches, reconciliation_json, skipped_json, created_at, completed_at'
      )
      .eq('rule_pack_id', parsedParams.data.id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;
    return NextResponse.json({ data: data ?? [] });
  } catch (err) {
    return rulePackErrorResponse(err, 'GET /api/rulepack/[id]/backtest');
  }
}
