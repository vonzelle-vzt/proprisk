import { NextRequest, NextResponse } from 'next/server';
import { sendManualEmail } from '@/lib/emails/send';
import { requireRiskUser } from '@/lib/auth/guards';
import { sendEmailBodySchema, validationErrorResponse } from '@/lib/api/schemas';
import { DEMO_MODE } from '@/lib/demo';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (DEMO_MODE) return NextResponse.json({ ok: true, demo: true, message: 'Demo: email not actually sent.' });
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json();
    const parsed = sendEmailBodySchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error);
    const { account_id, recipient, subject, body: emailBody, violation_id, deduction_id } = parsed.data;

    const result = await sendManualEmail({
      account_id,
      recipient,
      subject,
      body: emailBody,
      sent_by: auth.user.email || auth.user.id,
      violation_id,
      deduction_id,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
