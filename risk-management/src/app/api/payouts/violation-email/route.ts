export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { buildPayoutViolationEmail } from '@/lib/emails/templates';
import { sendEmail } from '@/lib/emails/transport';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { logError } from '@/lib/logging/logger';
import { DEMO_MODE } from '@/lib/demo';

/** Check if a payout_violation email was already sent for this account. */
export async function GET(request: NextRequest) {
  if (DEMO_MODE) return NextResponse.json({ sent: false, record: null });
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const accountId = request.nextUrl.searchParams.get('accountId');
  if (!accountId) return NextResponse.json({ sent: false, record: null });

  const supabase = await createClient();
  const { data } = await supabase
    .from('emails')
    .select('id, sent_at, sent_by, recipient')
    .eq('challenge_account_id', accountId)
    .eq('template_type', 'payout_violation')
    .eq('status', 'sent')
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({ sent: !!data, record: data || null });
}

export async function POST(request: NextRequest) {
  if (DEMO_MODE) return NextResponse.json({ ok: true, demo: true, message: 'Demo: violation email not actually sent.' });
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;
  const sentBy = auth.actor;

  try {
    const {
      accountId,
      login,
      email,
      firstName,
      selectedViolations,
      planName,
      payoutAmount,
      totalDeductions,
      rationale,
    } = await request.json();

    if (!email || !selectedViolations?.length || !login) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const supabase = await createClient();

    // Duplicate guard
    const { data: existing } = await supabase
      .from('emails')
      .select('id, sent_at')
      .eq('challenge_account_id', String(accountId))
      .eq('template_type', 'payout_violation')
      .eq('status', 'sent')
      .limit(1)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { error: 'Email already sent', sentAt: existing.sent_at },
        { status: 409 }
      );
    }

    const template = buildPayoutViolationEmail({
      firstName: firstName || 'Trader',
      login: String(login),
      planName: planName || '',
      violations: selectedViolations,
      totalDeductions: totalDeductions || 0,
      payoutAmount: payoutAmount || 0,
      // Optional — populated when the caller has a composed explainable
      // decision (see `src/lib/payouts/decision.ts`); absent for the legacy
      // manual-selection flow, in which case the email renders unchanged.
      rationale: rationale || undefined,
    });

    try {
      await sendEmail({ to: email, subject: template.subject, html: template.body });
    } catch (sendErr) {
      await supabase.from('emails').insert({
        tenant_id: auth.tenantId,
        challenge_account_id: String(accountId),
        recipient: email,
        subject: template.subject,
        body: template.body,
        template_type: 'payout_violation',
        sent_by: sentBy,
        status: 'failed',
      });
      throw sendErr;
    }

    await supabase.from('emails').insert({
      tenant_id: auth.tenantId,
      challenge_account_id: String(accountId),
      recipient: email,
      subject: template.subject,
      body: template.body,
      template_type: 'payout_violation',
      sent_by: sentBy,
      status: 'sent',
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    logError('Failed to send payout violation email', err, { route: '/api/payouts/violation-email' });
    return NextResponse.json({ error: 'Failed to send email' }, { status: 500 });
  }
}
