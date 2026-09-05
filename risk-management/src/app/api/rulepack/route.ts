export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireRiskManager, requireRiskUser } from '@/lib/auth/guards';
import { createDraft, listPacks } from '@/lib/rulepack/store';
import { presetById } from '@/lib/rulepack/presets';
import { DEMO_RULE_PACKS } from '@/lib/rulepack/demo';
import { DEMO_MODE } from '@/lib/demo';
import { createDraftBodySchema } from './_lib/schemas';
import { rulePackErrorResponse } from './_lib/errors';

/**
 * List and create rule packs.
 *
 * Reading a firm's rule packs is any risk-desk role's job; creating one moves
 * the firm's rulebook, so it is a manager action like every other
 * enforcement-grade write in this app.
 */

export async function GET() {
  if (DEMO_MODE) {
    return NextResponse.json({ data: DEMO_RULE_PACKS, demo: true });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  try {
    const packs = await listPacks(auth.tenantId);
    return NextResponse.json({ data: packs });
  } catch (err) {
    return rulePackErrorResponse(err, 'GET /api/rulepack');
  }
}

export async function POST(request: NextRequest) {
  if (DEMO_MODE) {
    return NextResponse.json({
      ok: true,
      demo: true,
      message: 'Demo: draft not persisted.',
    });
  }

  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = createDraftBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Tuning a preset happens client-side (the wizard edits the preset's own
  // pack shape), so `pack` — when present — always wins; `from_preset` is
  // kept only as the provenance tag so a firm can be told later when the
  // preset it started from has been revised.
  let packInput: unknown;
  if (parsed.data.pack !== undefined) {
    packInput = parsed.data.pack;
  } else {
    const preset = presetById(parsed.data.from_preset!);
    if (!preset) {
      return NextResponse.json(
        { error: `Unknown preset "${parsed.data.from_preset}"` },
        { status: 400 }
      );
    }
    packInput = preset.pack;
  }

  try {
    const created = await createDraft(auth.tenantId, {
      pack: packInput,
      derivedFrom: parsed.data.from_preset,
      createdBy: auth.user.id,
    });
    return NextResponse.json({ data: created }, { status: 201 });
  } catch (err) {
    return rulePackErrorResponse(err, 'POST /api/rulepack');
  }
}
