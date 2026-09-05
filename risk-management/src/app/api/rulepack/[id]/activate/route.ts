export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRiskManager } from '@/lib/auth/guards';
import { activate } from '@/lib/rulepack/store';
import { DEMO_MODE } from '@/lib/demo';
import { activateBodySchema } from '../../_lib/schemas';
import { rulePackErrorResponse } from '../../_lib/errors';

const idParamSchema = z.object({ id: z.string().uuid() });

/**
 * Activate a pack.
 *
 * `activate()` itself enforces the real gates — a clean backtest, and platform
 * sign-off for tenants still under supervision — and throws
 * `ActivationBlockedError` with the customer-facing reason when either is
 * missing. This route's only job is auth, id validation, and passing that
 * reason through unmodified.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  if (DEMO_MODE) {
    return NextResponse.json({ ok: true, demo: true, message: 'Demo: pack not activated.' });
  }

  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

  const parsedParams = idParamSchema.safeParse(params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: 'Invalid rule pack id' }, { status: 400 });
  }

  let body: unknown = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = activateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    await activate(auth.tenantId, parsedParams.data.id, parsed.data.approved_by ?? auth.actor);
    return NextResponse.json({ ok: true, message: 'Pack activated.' });
  } catch (err) {
    return rulePackErrorResponse(err, 'POST /api/rulepack/[id]/activate');
  }
}
