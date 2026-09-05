export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRiskUser } from '@/lib/auth/guards';
import { activePack } from '@/lib/rulepack/store';
import { diffRulePacks } from '@/lib/rulepack/diff';
import { findDemoPack } from '@/lib/rulepack/demo';
import { presetById } from '@/lib/rulepack/presets';
import { DEMO_MODE } from '@/lib/demo';
import { rulePackErrorResponse } from '../../_lib/errors';
import { findPack } from '../../_lib/get-pack';

const idParamSchema = z.object({ id: z.string().uuid() });
const queryParamSchema = z.object({ against: z.string().uuid().optional() });

/**
 * Plain-language diff for one pack.
 *
 * Defaults to comparing against the currently active pack for the same asset
 * class — "what would change if I published this" is the question that
 * matters before every publish — but accepts `?against=<packId>` to compare
 * any two versions.
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  // Demo ids are not UUIDs, and there is no tenant history to compare
  // against, so this diffs a demo pack against the preset it was derived
  // from using the real `diffRulePacks` — a computed result, not a 404.
  if (DEMO_MODE) {
    const target = findDemoPack(params.id);
    if (!target) return NextResponse.json({ error: 'Rule pack not found' }, { status: 404 });

    const preset = target.derivedFrom ? presetById(target.derivedFrom) : undefined;
    if (!preset) {
      return NextResponse.json({
        data: null,
        message: 'This sample pack has no preset to compare against.',
        demo: true,
      });
    }

    const diff = diffRulePacks(preset.pack, target.pack);
    return NextResponse.json({
      data: diff,
      before: { id: `preset:${preset.id}`, name: preset.label, version: 1, status: 'active' },
      after: { id: target.id, name: target.name, version: target.version, status: target.status },
      demo: true,
    });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const parsedParams = idParamSchema.safeParse(params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: 'Invalid rule pack id' }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const parsedQuery = queryParamSchema.safeParse(Object.fromEntries(searchParams.entries()));
  if (!parsedQuery.success) {
    return NextResponse.json({ error: 'Invalid "against" query param' }, { status: 400 });
  }

  try {
    const target = await findPack(auth.tenantId, parsedParams.data.id);
    if (!target) return NextResponse.json({ error: 'Rule pack not found' }, { status: 404 });

    const baseline = parsedQuery.data.against
      ? await findPack(auth.tenantId, parsedQuery.data.against)
      : await activePack(auth.tenantId, target.assetClass);

    if (!baseline) {
      return NextResponse.json({
        data: null,
        message: parsedQuery.data.against
          ? 'The pack named in "against" was not found.'
          : 'No active pack to compare against for this asset class — this would be the first.',
      });
    }

    const diff = diffRulePacks(baseline.pack, target.pack);
    return NextResponse.json({
      data: diff,
      before: { id: baseline.id, name: baseline.name, version: baseline.version, status: baseline.status },
      after: { id: target.id, name: target.name, version: target.version, status: target.status },
    });
  } catch (err) {
    return rulePackErrorResponse(err, 'GET /api/rulepack/[id]/diff');
  }
}
