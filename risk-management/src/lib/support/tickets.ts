import { DEMO_MODE } from '@/lib/demo';
import { tenantDb } from '@/lib/db/tenant-scoped';
import { sendEmail } from '@/lib/emails/transport';
import { gatherDiagnostics, type TicketDiagnostics } from './diagnostics';

export function supportInbox(): string {
  const inbox = process.env.SUPPORT_INBOX_EMAIL;
  if (inbox) return inbox;
  if (DEMO_MODE) return 'support@example.com';
  throw new Error('SUPPORT_INBOX_EMAIL is not set — support tickets have nowhere to go');
}

export type TicketSeverity = 'low' | 'normal' | 'high' | 'urgent';

export interface CreateTicketInput {
  tenantId: string;
  createdBy: string;
  createdByEmail: string;
  subject: string;
  body: string;
  severity: TicketSeverity;
}

export interface SupportTicket {
  id: string;
  subject: string;
  body: string;
  severity: TicketSeverity;
  status: 'open' | 'in_progress' | 'resolved';
  createdAt: string;
}

export async function createTicket(input: CreateTicketInput): Promise<SupportTicket> {
  const diagnostics = await gatherDiagnostics(input.tenantId);

  const { data, error } = await tenantDb(input.tenantId, 'support ticket create')
    .insert('support_tickets', {
      created_by: input.createdBy,
      subject: input.subject,
      body: input.body,
      severity: input.severity,
      diagnostics_json: diagnostics,
    })
    .select('id, subject, body, severity, status, created_at')
    .single();
  if (error || !data) throw error ?? new Error('Failed to create ticket');

  const ticket: SupportTicket = {
    id: data.id,
    subject: data.subject,
    body: data.body,
    severity: data.severity,
    status: data.status,
    createdAt: data.created_at,
  };

  // Ticket creation must succeed even if outbound mail fails — the row is the
  // source of truth (the firm can see its status in-app), the email is a
  // notification on top of it, matching the invite-email failure handling in
  // src/app/api/tenancy/invites/route.ts.
  try {
    await sendEmail({
      to: supportInbox(),
      subject: `[Support] ${input.subject}`,
      html: renderTicketEmail(input, ticket, diagnostics),
    });
  } catch {
    // swallow — see comment above
  }

  return ticket;
}

function renderTicketEmail(
  input: CreateTicketInput,
  ticket: SupportTicket,
  diagnostics: TicketDiagnostics
): string {
  const connectionsLine = diagnostics.connections
    .filter((c) => c.enabled)
    .map((c) => c.provider)
    .join(', ') || 'none enabled';
  const errorsLine = diagnostics.recentErrors.length
    ? diagnostics.recentErrors.map((e) => `${e.action} @ ${e.occurredAt}`).join('<br/>')
    : 'none';

  return `
    <h2>${input.subject}</h2>
    <p><strong>Severity:</strong> ${input.severity}</p>
    <p><strong>From:</strong> ${input.createdByEmail}</p>
    <p>${input.body}</p>
    <hr/>
    <h3>Diagnostics</h3>
    <p><strong>Tenant:</strong> ${diagnostics.tenant?.name ?? 'unknown'} (${diagnostics.tenant?.id ?? input.tenantId})</p>
    <p><strong>Plan tier:</strong> ${diagnostics.tenant?.planTier ?? 'unknown'}</p>
    <p><strong>App version:</strong> ${diagnostics.appVersion ?? 'unknown'}</p>
    <p><strong>Connections enabled:</strong> ${connectionsLine}</p>
    <p><strong>Recent errors:</strong><br/>${errorsLine}</p>
    <p><strong>Ticket id:</strong> ${ticket.id}</p>
  `;
}

export async function listTickets(tenantId: string): Promise<SupportTicket[]> {
  const { data, error } = await tenantDb(tenantId, 'support ticket list')
    .select('support_tickets', 'id, subject, body, severity, status, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    subject: string;
    body: string;
    severity: TicketSeverity;
    status: 'open' | 'in_progress' | 'resolved';
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    body: row.body,
    severity: row.severity,
    status: row.status,
    createdAt: row.created_at,
  }));
}
