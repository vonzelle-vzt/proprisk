export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRiskManager } from '@/lib/auth/guards';
import { promoteToTesting } from '@/lib/rulepack/store';
import { DEMO_MODE } from '@/lib/demo';
import { rulePackErrorResponse } from '../../_lib/errors';

const idParamSchema = z.object({ id: z.string().uuid() });

/** Draft -> testing. A pack in testing is real and evaluated but never enforces. */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  if (DEMO_MODE) {
    return NextResponse.json({ ok: true, demo: true, message: 'Demo: pack not promoted.' });
  }

  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

  const parsedParams = idParamSchema.safeParse(params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: 'Invalid rule pack id' }, { status: 400 });
  }

  try {
    await promoteToTesting(auth.tenantId, parsedParams.data.id);
    return NextResponse.json({ ok: true, message: 'Pack moved to testing. Run a backtest before activating.' });
  } catch (err) {
    return rulePackErrorResponse(err, 'POST /api/rulepack/[id]/promote');
  }
}
