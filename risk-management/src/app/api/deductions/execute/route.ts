import { NextRequest, NextResponse } from 'next/server';
import { executeDeduction } from '@/lib/deductions/execute';
import { requireRiskUser } from '@/lib/auth/guards';
import { executeDeductionBodySchema, validationErrorResponse } from '@/lib/api/schemas';
import { DEMO_MODE } from '@/lib/demo';
import { invalidate } from '@/lib/cache/provider-cache';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (DEMO_MODE) return NextResponse.json({ ok: true, demo: true, message: 'Demo: deduction not actually executed.' });
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json();
    const parsed = executeDeductionBodySchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error);
    const { account_id, amount, reason, violation_id } = parsed.data;

    const result = await executeDeduction({
      account_id,
      violation_id,
      amount,
      reason,
      execution_type: 'manual',
      executed_by: auth.user.email || auth.user.id,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    // Best-effort: never fail an already-executed deduction over a cache
    // invalidation error.
    try {
      await invalidate('provider:deductions');
      await invalidate('provider:violations');
    } catch (err) {
      console.error('[deductions/execute] cache invalidation failed', err);
    }

    return NextResponse.json({ success: true, deduction_id: result.deduction_id });
  } catch (error: any) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
