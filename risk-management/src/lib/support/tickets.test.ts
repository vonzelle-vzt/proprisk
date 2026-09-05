import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const insertCalls: Array<Record<string, unknown>> = [];
// vi.mock factories are hoisted above ordinary top-level declarations, so a
// plain `const sendEmailMock = vi.fn()` referenced from a factory below would
// hit the TDZ; vi.hoisted() is the supported escape hatch for exactly this.
const { sendEmailMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn(async () => {}) }));

vi.mock('@/lib/db/tenant-scoped', () => ({
  tenantDb: () => ({
    insert: (table: string, row: Record<string, unknown>) => {
      insertCalls.push({ table, row });
      return {
        select: () => ({
          single: async () => ({
            data: {
              id: 'ticket-1',
              subject: row.subject,
              body: row.body,
              severity: row.severity,
              status: 'open',
              created_at: '2026-01-01T00:00:00Z',
            },
            error: null,
          }),
        }),
      };
    },
    select: () => ({
      order: async () => ({ data: [], error: null }),
    }),
  }),
}));

vi.mock('@/lib/emails/transport', () => ({ sendEmail: sendEmailMock }));

const DIAGNOSTICS_FIXTURE = {
  tenant: { id: 'tenant-1', name: 'Acme', planTier: 'starter' },
  appVersion: 'abc123',
  connections: [{ provider: 'tradovate', enabled: true }],
  recentErrors: [],
};

vi.mock('./diagnostics', () => ({
  gatherDiagnostics: vi.fn(async () => DIAGNOSTICS_FIXTURE),
}));

import { createTicket } from './tickets';

const INPUT = {
  tenantId: 'tenant-1',
  createdBy: 'user-1',
  createdByEmail: 'dana@firm.com',
  subject: 'Sync broken',
  body: 'Trades stopped syncing after the last deploy',
  severity: 'high' as const,
};

const TEST_SUPPORT_INBOX = 'support-test@example.com';
const ORIGINAL_SUPPORT_INBOX_EMAIL = process.env.SUPPORT_INBOX_EMAIL;

describe('createTicket', () => {
  beforeEach(() => {
    insertCalls.length = 0;
    sendEmailMock.mockReset().mockResolvedValue(undefined);
    process.env.SUPPORT_INBOX_EMAIL = TEST_SUPPORT_INBOX;
  });

  afterEach(() => {
    if (ORIGINAL_SUPPORT_INBOX_EMAIL === undefined) {
      delete process.env.SUPPORT_INBOX_EMAIL;
    } else {
      process.env.SUPPORT_INBOX_EMAIL = ORIGINAL_SUPPORT_INBOX_EMAIL;
    }
  });

  it('attaches gathered diagnostics to the stored ticket', async () => {
    await createTicket(INPUT);

    expect(insertCalls).toHaveLength(1);
    const row = insertCalls[0].row as Record<string, unknown>;
    expect(row.diagnostics_json).toEqual(DIAGNOSTICS_FIXTURE);
    expect(row.subject).toBe(INPUT.subject);
  });

  // The row is the source of truth (the firm sees status in-app); email is a
  // notification layered on top and must not gate ticket creation, matching
  // the invite-email failure handling in src/app/api/tenancy/invites/route.ts.
  it('still returns the created ticket when the notification email fails', async () => {
    sendEmailMock.mockRejectedValueOnce(new Error('RESEND_API_KEY is not set'));

    const ticket = await createTicket(INPUT);

    expect(ticket.id).toBe('ticket-1');
  });

  it('emails the configured support inbox', async () => {
    await createTicket(INPUT);

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: TEST_SUPPORT_INBOX })
    );
  });
});

describe('createTicket support inbox configuration', () => {
  beforeEach(() => {
    insertCalls.length = 0;
    sendEmailMock.mockReset().mockResolvedValue(undefined);
    delete process.env.SUPPORT_INBOX_EMAIL;
  });

  afterEach(() => {
    if (ORIGINAL_SUPPORT_INBOX_EMAIL === undefined) {
      delete process.env.SUPPORT_INBOX_EMAIL;
    } else {
      process.env.SUPPORT_INBOX_EMAIL = ORIGINAL_SUPPORT_INBOX_EMAIL;
    }
    vi.doUnmock('@/lib/demo');
  });

  it('throws when SUPPORT_INBOX_EMAIL is unset outside demo mode', async () => {
    vi.doMock('@/lib/demo', () => ({ DEMO_MODE: false }));
    vi.resetModules();
    const { supportInbox: supportInboxNoConfig } = await import('./tickets');

    expect(() => supportInboxNoConfig()).toThrow(
      'SUPPORT_INBOX_EMAIL is not set — support tickets have nowhere to go'
    );
  });
});
