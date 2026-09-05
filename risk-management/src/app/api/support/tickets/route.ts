import { NextRequest, NextResponse } from 'next/server';
import { validationErrorResponse } from '@/lib/api/schemas';
import { createTicketBodySchema } from '@/lib/support/schemas';
import { createTicket, listTickets } from '@/lib/support/tickets';
import { requireTenantMember } from '@/lib/tenancy/guards';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireTenantMember();
  if (!auth.ok) return auth.response;

  try {
    const tickets = await listTickets(auth.tenantId);
    return NextResponse.json({ data: tickets });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireTenantMember();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = createTicketBodySchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  try {
    const ticket = await createTicket({
      tenantId: auth.tenantId,
      createdBy: auth.user.id,
      createdByEmail: auth.user.email ?? auth.user.id,
      subject: parsed.data.subject,
      body: parsed.data.body,
      severity: parsed.data.severity,
    });
    return NextResponse.json({ data: ticket }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Failed to create ticket' }, { status: 500 });
  }
}
