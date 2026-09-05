export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { DEMO_MODE } from '@/lib/demo';
import { requireRiskUser } from '@/lib/auth/guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';
import { logAuditEvent } from '@/lib/audit/chain';
import { buildEvidencePack } from '@/lib/evidence/builder';

const bodySchema = z.object({
  subjectType: z.enum(['payout', 'violation', 'account', 'investigation']),
  subjectId: z.string().trim().min(1).max(200),
  accountId: z.string().trim().min(1).max(200).optional(),
  assetClass: z.enum(['forex', 'futures']).optional(),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', details: parsed.error.flatten() }, { status: 400 });
  }
  const { subjectType, subjectId, accountId, assetClass } = parsed.data;

  if (DEMO_MODE) {
    const pack = await buildEvidencePack({ subjectType, subjectId, accountId, assetClass });
    return NextResponse.json({ data: pack });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('evidence-generate', { windowMs: 60_000, maxRequests: 20 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const pack = await buildEvidencePack({ subjectType, subjectId, accountId, assetClass });

    await logAuditEvent({
      action_type: 'evidence_pack_generated',
      entity_type: subjectType,
      entity_id: subjectId,
      performed_by: auth.user.email || auth.user.id,
      details: { evidence_pack_id: pack.id, account_id: pack.accountId },
    });

    return NextResponse.json({ data: pack });
  } catch (err) {
    logError('Failed to build evidence pack', err, {
      route: '/api/evidence',
      category: 'internal',
    });
    return NextResponse.json({ error: 'Failed to build evidence pack' }, { status: 500 });
  }
}
