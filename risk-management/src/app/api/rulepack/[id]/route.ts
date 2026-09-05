export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRiskManager, requireRiskUser } from '@/lib/auth/guards';
import { updateDraft } from '@/lib/rulepack/store';
import { findDemoPack } from '@/lib/rulepack/demo';
import { DEMO_MODE } from '@/lib/demo';
import { updateDraftBodySchema } from '../_lib/schemas';
import { rulePackErrorResponse } from '../_lib/errors';
import { findPack } from '../_lib/get-pack';

const idParamSchema = z.object({ id: z.string().uuid() });

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  if (DEMO_MODE) {
    const pack = findDemoPack(params.id);
    if (!pack) return NextResponse.json({ error: 'Rule pack not found' }, { status: 404 });
    return NextResponse.json({ data: pack, demo: true });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const parsedParams = idParamSchema.safeParse(params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: 'Invalid rule pack id' }, { status: 400 });
  }

  try {
    const pack = await findPack(auth.tenantId, parsedParams.data.id);
    if (!pack) return NextResponse.json({ error: 'Rule pack not found' }, { status: 404 });
    return NextResponse.json({ data: pack });
  } catch (err) {
    return rulePackErrorResponse(err, 'GET /api/rulepack/[id]');
  }
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  if (DEMO_MODE) {
    return NextResponse.json({ ok: true, demo: true, message: 'Demo: draft not persisted.' });
  }

  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

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

  const parsed = updateDraftBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const updated = await updateDraft(auth.tenantId, parsedParams.data.id, parsed.data.pack);
    return NextResponse.json({ data: updated });
  } catch (err) {
    return rulePackErrorResponse(err, 'PATCH /api/rulepack/[id]');
  }
}
