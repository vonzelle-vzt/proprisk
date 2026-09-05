import { beforeEach, describe, expect, it, vi } from 'vitest';

const createClientMock = vi.fn();
const requireRiskUserMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => createClientMock(),
}));

vi.mock('@/lib/auth/guards', () => ({
  requireRiskUser: () => requireRiskUserMock(),
}));

const ANALYST = {
  ok: true as const,
  user: { id: 'user-1', email: 'analyst@firm.com' },
  role: 'risk_analyst',
  actor: 'analyst@firm.com',
  tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
};

import { POST } from './route';

type PretradeMockOptions = {
  profile?: { id: string; rules_json: unknown[] } | null;
  profileError?: { message: string } | null;
  insertError?: { message: string } | null;
};

function buildPretradeSupabaseMock(options: PretradeMockOptions) {
  return {
    from: (table: string) => {
      if (table === 'risk_profiles') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({
                      data: options.profile ?? null,
                      error: options.profileError ?? null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }

      if (table === 'risk_pretrade_decisions') {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({
                data: options.insertError ? null : { id: 'decision-123' },
                error: options.insertError ?? null,
              }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };
}

describe('POST /api/risk/pretrade-evaluate', () => {
  const validBody = {
    account_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    symbol: 'EURUSD',
    direction: 'buy',
    entry_price: 1.1,
    stop_loss_price: 1.095,
    quantity: 1000,
    account_balance: 10000,
    open_exposure_value: 2000,
    daily_realized_pnl: -150,
    consecutive_losses: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    requireRiskUserMock.mockResolvedValue(ANALYST);
  });

  it('returns 404 when no active profile exists', async () => {
    createClientMock.mockReturnValue(buildPretradeSupabaseMock({ profile: null }));

    const response = await POST(
      new Request('http://localhost/api/risk/pretrade-evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      }) as any
    );
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.error).toContain('No active risk profile');
  });

  it('returns 200 with a stored decision id when profile exists', async () => {
    createClientMock.mockReturnValue(
      buildPretradeSupabaseMock({
        profile: {
          id: 'profile-1',
          rules_json: [
            {
              id: 'rule-1',
              type: 'max_position_risk_pct',
              enabled: true,
              threshold: 2,
              warning_threshold: 1,
              instrument_list: null,
            },
          ],
        },
      })
    );

    const response = await POST(
      new Request('http://localhost/api/risk/pretrade-evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      }) as any
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.decision_id).toBe('decision-123');
    expect(['pass', 'warn', 'block']).toContain(payload.data.result);
  });

  it('returns 400 for invalid payloads', async () => {
    const response = await POST(
      new Request('http://localhost/api/risk/pretrade-evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'EURUSD' }),
      }) as any
    );

    expect(response.status).toBe(400);
  });
});
