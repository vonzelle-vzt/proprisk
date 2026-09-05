import { beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';

const upsertCalls: Array<{ table: string; rows: unknown; options?: { onConflict?: string } }> = [];
const selectCalls: Array<{ table: string; columns: string }> = [];

let existingRecord: { id: string; status: string } | null = null;
let upsertResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };

vi.mock('@/lib/db/tenant-scoped', () => ({
  tenantDb: (tenantId: string) => ({
    select: (table: string, columns: string) => {
      selectCalls.push({ table, columns });
      return {
        eq: () => ({
          returns: () => ({
            maybeSingle: async () => ({ data: existingRecord, error: null }),
          }),
        }),
      };
    },
    upsert: (table: string, rows: unknown, options?: { onConflict?: string }) => {
      upsertCalls.push({ table, rows: { ...(rows as Record<string, unknown>), tenant_id: tenantId }, options });
      return {
        select: () => ({
          maybeSingle: async () => upsertResult,
        }),
      };
    },
    from: (table: string) => {
      const builder: any = {
        eq: () => builder,
        contains: () => builder,
        order: () => builder,
        in: () => builder,
        range: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return builder;
    },
    update: () => ({
      eq: async () => ({ error: null }),
    }),
  }),
}));

vi.mock('@/lib/logging/logger', () => ({
  logError: vi.fn(),
}));

import { upsertFraudInvestigation } from './persistence';
import type { FraudFinding } from '@/types/fraud';

function finding(overrides: Partial<FraudFinding> = {}): FraudFinding {
  return {
    account_ids: ['a1', 'a2'],
    user_ids: ['user@ringmail.io'],
    primary_account: 'a1',
    confidence_score: 80,
    severity: 'high',
    title: 'Copy ring',
    summary: 'summary',
    evidence: { detector: 'copy_ring', run_timestamp: new Date().toISOString() },
    total_amount_at_risk: 1000,
    recommended_action: 'Investigate',
    dedupe_key: 'copy_ring:a1:a2:2026-08-05',
    ...overrides,
  };
}

describe('upsertFraudInvestigation', () => {
  beforeEach(() => {
    upsertCalls.length = 0;
    selectCalls.length = 0;
    existingRecord = null;
    upsertResult = { data: null, error: null };
    vi.clearAllMocks();
  });

  it('upserts on the composite (tenant_id, dedupe_key) conflict target, not the old bare dedupe_key', async () => {
    upsertResult = { data: { id: 'inv-1', ...finding() }, error: null };

    await upsertFraudInvestigation(TENANT_A, 'copy_ring', finding());

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].options?.onConflict).toBe('tenant_id,dedupe_key');
  });

  it('actually persists the finding and returns the stored row (the bug this fixes silently dropped every finding)', async () => {
    const stored = { id: 'inv-1', fraud_type: 'copy_ring', dedupe_key: finding().dedupe_key };
    upsertResult = { data: stored, error: null };

    const result = await upsertFraudInvestigation(TENANT_A, 'copy_ring', finding());

    expect(result).toEqual(stored);
    expect(upsertCalls[0].rows).toMatchObject({
      dedupe_key: finding().dedupe_key,
      tenant_id: TENANT_A,
    });
  });

  it('throws (does not silently return null) when the write itself fails, so a persistence failure is visible to the caller', async () => {
    upsertResult = { data: null, error: { message: '42P10 invalid_column_reference' } };

    await expect(upsertFraudInvestigation(TENANT_A, 'copy_ring', finding())).rejects.toBeTruthy();
  });

  it('skips (returns null, does not throw) when a duplicate is already resolved — not a failure', async () => {
    existingRecord = { id: 'inv-1', status: 'dismissed' };

    const result = await upsertFraudInvestigation(TENANT_A, 'copy_ring', finding());

    expect(result).toBeNull();
    expect(upsertCalls).toHaveLength(0);
  });
});
