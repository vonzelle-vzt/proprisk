export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { buildChallengeResetEmail } from '@/lib/emails/templates';
import { sendEmail } from '@/lib/emails/transport';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { logError } from '@/lib/logging/logger';
import { DEMO_MODE } from '@/lib/demo';

/** Check if a challenge_reset email was already sent for this account. */
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
    .eq('template_type', 'challenge_reset')
    .eq('status', 'sent')
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({ sent: !!data, record: data || null });
}

export async function POST(request: NextRequest) {
  if (DEMO_MODE) return NextResponse.json({ ok: true, demo: true, message: 'Demo: challenge reset email not actually sent.' });
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;
  const sentBy = auth.actor;

  try {
    const {
      accountId,
      violatedAccounts,
      email,
      firstName,
      retryAccountId,
      selectedViolations,
      planName,
      phaseLabel,
    } = await request.json();

    if (!email || !retryAccountId || !selectedViolations?.length || !violatedAccounts?.length) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const supabase = await createClient();

    // Duplicate guard — block if a successful send already exists for this account
    const { data: existing } = await supabase
      .from('emails')
      .select('id, sent_at')
      .eq('challenge_account_id', String(accountId))
      .eq('template_type', 'challenge_reset')
      .eq('status', 'sent')
      .limit(1)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { error: 'Email already sent', sentAt: existing.sent_at },
        { status: 409 }
      );
    }

    // selectedViolations: { label: string; deductionAmount: number }[]
    const template = buildChallengeResetEmail({
      firstName: firstName || 'Trader',
      violatedAccounts,
      planName: planName || '',
      phaseLabel: phaseLabel || 'Phase',
      violations: selectedViolations,
      retryAccountId,
    });

    try {
      await sendEmail({ to: email, subject: template.subject, html: template.body });
    } catch (sendErr) {
      // Log the failure so it's visible in the DB
      await supabase.from('emails').insert({
        tenant_id: auth.tenantId,
        challenge_account_id: String(accountId),
        recipient: email,
        subject: template.subject,
        body: template.body,
        template_type: 'challenge_reset',
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
      template_type: 'challenge_reset',
      sent_by: sentBy,
      status: 'sent',
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    logError('Failed to send challenge violation email', err, { route: '/api/challenges/violation-email' });
    return NextResponse.json({ error: 'Failed to send email' }, { status: 500 });
  }
}
