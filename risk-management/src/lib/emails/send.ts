import { createAdminClient } from '@/lib/supabase/admin';
import { ViolationType, Account } from '@/types/database';
import { VIOLATION_LABELS } from '@/config/violations';
import { getEmailTemplate } from '@/lib/emails/templates';
import { sendEmail } from '@/lib/emails/transport';
import { logAuditEvent } from '@/lib/deductions/audit';

interface SendViolationEmailParams {
  account: Account;
  violation_type: ViolationType;
  deduction_amount: number;
  deduction_id: string;
  violation_id?: string;
}

interface SendManualEmailParams {
  account_id: string;
  recipient: string;
  subject: string;
  body: string;
  sent_by: string;
  violation_id?: string;
  deduction_id?: string;
}

export async function sendViolationEmail(params: SendViolationEmailParams): Promise<void> {
  const supabase = createAdminClient();
  const template = getEmailTemplate(params.violation_type, {
    trader_name: params.account.trader_name,
    account_login: params.account.login,
    violation_type_label: VIOLATION_LABELS[params.violation_type] || params.violation_type,
    deduction_amount: params.deduction_amount.toFixed(2),
    date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
  });

  try {
    await sendEmail({
      to: params.account.email,
      subject: template.subject,
      html: template.body,
    });

    await supabase.from('emails').insert({
      account_id: params.account.id,
      violation_id: params.violation_id || null,
      deduction_id: params.deduction_id,
      recipient: params.account.email,
      subject: template.subject,
      body: template.body,
      template_type: params.violation_type,
      sent_by: 'system',
      status: 'sent',
    });

    await logAuditEvent({
      action_type: 'email_sent',
      entity_type: 'email',
      entity_id: params.account.id,
      performed_by: 'system',
      details: {
        recipient: params.account.email,
        subject: template.subject,
        violation_type: params.violation_type,
        deduction_amount: params.deduction_amount,
      },
    });
  } catch (error: any) {
    await supabase.from('emails').insert({
      account_id: params.account.id,
      violation_id: params.violation_id || null,
      deduction_id: params.deduction_id,
      recipient: params.account.email,
      subject: template.subject,
      body: template.body,
      template_type: params.violation_type,
      sent_by: 'system',
      status: 'failed',
    });
    throw error;
  }
}

export async function sendManualEmail(params: SendManualEmailParams): Promise<{ success: boolean; error?: string }> {
  const supabase = createAdminClient();

  try {
    await sendEmail({
      to: params.recipient,
      subject: params.subject,
      html: params.body,
    });

    await supabase.from('emails').insert({
      account_id: params.account_id,
      violation_id: params.violation_id || null,
      deduction_id: params.deduction_id || null,
      recipient: params.recipient,
      subject: params.subject,
      body: params.body,
      template_type: 'manual',
      sent_by: params.sent_by,
      status: 'sent',
    });

    await logAuditEvent({
      action_type: 'manual_email_sent',
      entity_type: 'email',
      entity_id: params.account_id,
      performed_by: params.sent_by,
      details: { recipient: params.recipient, subject: params.subject },
    });

    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
