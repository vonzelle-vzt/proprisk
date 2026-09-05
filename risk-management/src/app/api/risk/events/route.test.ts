import { beforeEach, describe, expect, it, vi } from 'vitest';

const createClientMock = vi.fn();
const processRiskTradeEventMock = vi.fn();
const requireRiskUserMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => createClientMock(),
}));

vi.mock('@/lib/auth/guards', () => ({
  requireRiskUser: () => requireRiskUserMock(),
}));

vi.mock('@/lib/risk/worker', () => ({
  processRiskTradeEvent: (...args: unknown[]) => processRiskTradeEventMock(...args),
}));

const ANALYST = {
  ok: true as const,
  user: { id: 'user-1', email: 'analyst@firm.com' },
  role: 'risk_analyst',
  actor: 'analyst@firm.com',
  tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
};

import { POST } from './route';

type EventsMockOptions = {
  existing?: Array<{ id: string }>;
  existingError?: { message: string } | null;
  insertedData?: Record<string, unknown> | null;
  insertError?: { message: string } | null;
};

function buildEventsSupabaseMock(options: EventsMockOptions) {
  return {
    from: (table: string) => {
      if (table !== 'risk_trade_events') {
        throw new Error(`Unexpected table ${table}`);
      }

      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              limit: async () => ({
                data: options.existing ?? [],
                error: options.existingError ?? null,
              }),
            }),
          }),
        }),
        insert: () => ({
          select: () => ({
            single: async () => ({
              data:
                options.insertedData ??
                ({
                  id: 'event-1',
                  account_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                  event_type: 'trade_closed',
                  symbol: 'EURUSD',
                  pnl_delta: -1000,
                  exposure_value: 2000,
                  quantity: 1000,
                  price: 1.1,
                  metadata_json: { source: 'test' },
                  occurred_at: new Date().toISOString(),
                  idempotency_key: 'idem-1',
                } as Record<string, unknown>),
              error: options.insertError ?? null,
            }),
          }),
        }),
      };
    },
  };
}

describe('POST /api/risk/events', () => {
  const validBody = {
    account_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    event_type: 'trade_closed',
    symbol: 'EURUSD',
    pnl_delta: -1200,
    exposure_value: 2500,
    quantity: 1000,
    price: 1.099,
    idempotency_key: 'idem-12345678',
    metadata: { source: 'test' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    processRiskTradeEventMock.mockResolvedValue(true);
    requireRiskUserMock.mockResolvedValue(ANALYST);
  });

  it('returns deduplicated true when idempotency key already exists', async () => {
    createClientMock.mockReturnValue(
      buildEventsSupabaseMock({
        existing: [{ id: 'already-there' }],
      })
    );

    const response = await POST(
      new Request('http://localhost/api/risk/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      }) as any
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.deduplicated).toBe(true);
    expect(processRiskTradeEventMock).not.toHaveBeenCalled();
  });

  it('returns 202 and processes inserted events', async () => {
    createClientMock.mockReturnValue(buildEventsSupabaseMock({ existing: [] }));

    const response = await POST(
      new Request('http://localhost/api/risk/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      }) as any
    );
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.data.accepted).toBe(true);
    expect(payload.data.processed).toBe(true);
    expect(processRiskTradeEventMock).toHaveBeenCalledTimes(1);
  });

  it('returns 400 for invalid payloads', async () => {
    const response = await POST(
      new Request('http://localhost/api/risk/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: 'trade_closed' }),
      }) as any
    );
    expect(response.status).toBe(400);
  });
});
