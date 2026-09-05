export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { recordPlatformApproval } from '@/lib/rulepack/store';
import { globalTable, tenantDb } from '@/lib/db/tenant-scoped';
import { logError } from '@/lib/logging/logger';
import { DEMO_MODE } from '@/lib/demo';

/**
 * Platform-operator review queue for the staged launch.
 *
 * A firm self-serves everything up to the point of enforcement. This route is
 * where we read the backtest reconciliation for a pack that is ready to go
 * live, and sign it off — a few minutes on a machine-generated diff, not an
 * onboarding call.
 *
 * Authenticated by PLATFORM_ADMIN_SECRET at the edge (middleware.ts), because
 * the caller acts ACROSS tenants and therefore has no tenant session. The
 * secret is the only authentication this route has, so it is checked before the
 * demo-mode bypass rather than after.
 *
 * GET  — packs awaiting review, with the reconciliation that justifies each.
 * POST — record sign-off for one pack version.
 */

const approvalSchema = z.object({
  tenant_id: z.string().uuid(),
  rule_pack_id: z.string().uuid(),
  approved_by: z.string().trim().min(1).max(200),
  note: z.string().trim().max(2000).optional(),
  backtest_run_id: z.string().uuid().optional(),
});

export async function GET() {
  if (DEMO_MODE) {
    return NextResponse.json({ data: [], demo: true });
  }

  try {
    // Only tenants still under supervision have a queue. Once the flag is
    // cleared for a firm, its packs activate on the backtest alone.
    const { data: tenants, error: tenantErr } = await globalTable('tenants')
      .select('id, name, slug, plan_tier')
      .eq('enforcement_approval_required', true)
      .eq('status', 'active');
    if (tenantErr) throw tenantErr;

    const pending = [];

    for (const t of (tenants ?? []) as unknown as Array<{
      id: string;
      name: string;
      slug: string;
      plan_tier: string;
    }>) {
      const db = tenantDb(t.id, 'platform-admin review queue');

      const { data: packs, error: packErr } = await db
        .select(
          'rule_packs',
          'id, name, asset_class, version, status, pack_json, platform_approved_at, created_at'
        )
        .eq('status', 'testing');
      if (packErr) throw packErr;

      for (const p of (packs ?? []) as unknown as Array<Record<string, unknown>>) {
        if (p.platform_approved_at) continue;

        // The reconciliation is the whole point of the review: it is what says
        // whether this pack would have missed a breach the firm's own platform
        // caught. A pack with no completed backtest is not reviewable yet.
        const { data: runs } = await db
          .select(
            'backtest_runs',
            'id, status, accounts_evaluated, engine_breaches, provider_breaches, reconciliation_json, skipped_json, completed_at'
          )
          .eq('rule_pack_id', String(p.id))
          .eq('status', 'complete')
          .order('created_at', { ascending: false })
          .limit(1);

        const latest = Array.isArray(runs) ? runs[0] : undefined;
        if (!latest) continue;

        pending.push({
          tenant: { id: t.id, name: t.name, slug: t.slug, plan_tier: t.plan_tier },
          pack: {
            id: p.id,
            name: p.name,
            asset_class: p.asset_class,
            version: p.version,
            rules: (p.pack_json as { rules?: unknown })?.rules ?? null,
          },
          backtest: latest,
        });
      }
    }

    return NextResponse.json({ data: pending, total: pending.length });
  } catch (err) {
    logError('Platform admin review queue failed', err, {
      route: 'api/platform-admin/rule-packs',
      category: 'database',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (DEMO_MODE) {
    return NextResponse.json({ ok: true, demo: true, message: 'Demo: approval not recorded.' });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = approvalSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    await recordPlatformApproval(parsed.data.tenant_id, parsed.data.rule_pack_id, {
      approvedBy: parsed.data.approved_by,
      note: parsed.data.note,
      backtestRunId: parsed.data.backtest_run_id,
    });

    // Sign-off does NOT activate the pack. The firm still chooses when to go
    // live, and activate() still enforces its own preconditions — this only
    // removes the platform's hold.
    return NextResponse.json({
      ok: true,
      message: 'Approval recorded. The firm can now activate this pack.',
    });
  } catch (err) {
    logError('Failed to record platform approval', err, {
      route: 'api/platform-admin/rule-packs',
      category: 'database',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
