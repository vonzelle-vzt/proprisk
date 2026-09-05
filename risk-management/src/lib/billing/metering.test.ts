import { describe, expect, it, vi } from 'vitest';

/**
 * A minimal thenable query-builder stub: `.eq()` chains (like the real
 * Supabase builder) and resolving it (via `await`) yields the configured
 * result. Good enough for metering, which only ever reads.
 */
function fakeQuery(result: { data?: unknown; count?: number | null; error?: unknown }) {
  const builder: Record<string, unknown> = {
    eq: vi.fn(() => builder),
    then: (resolve: (value: unknown) => unknown) => resolve(result),
  };
  return builder;
}

const selectMock = vi.fn();
const insertMock = vi.fn();

vi.mock('@/lib/db/tenant-scoped', () => ({
  tenantDb: (tenantId: string) => ({
    tenantId,
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
  }),
}));

import { countFundedAccountsMonitored, recordUsageSnapshot } from './metering';

describe('countFundedAccountsMonitored', () => {
  it('counts active, funded-phase accounts for the tenant', async () => {
    selectMock.mockReturnValueOnce(fakeQuery({ count: 7, error: null }));

    const count = await countFundedAccountsMonitored('tenant-1');

    expect(count).toBe(7);
    expect(selectMock).toHaveBeenCalledWith('accounts', 'id', { count: 'exact' });
  });

  it('treats a null count as zero rather than throwing', async () => {
    selectMock.mockReturnValueOnce(fakeQuery({ count: null, error: null }));

    const count = await countFundedAccountsMonitored('tenant-1');

    expect(count).toBe(0);
  });

  it('propagates a database error rather than reporting a false count', async () => {
    selectMock.mockReturnValueOnce(fakeQuery({ error: { message: 'db down' } }));

    await expect(countFundedAccountsMonitored('tenant-1')).rejects.toBeTruthy();
  });
});

describe('recordUsageSnapshot', () => {
  it('inserts one snapshot row carrying the counted usage', async () => {
    selectMock.mockReturnValueOnce(fakeQuery({ count: 12, error: null }));
    insertMock.mockReturnValueOnce(Promise.resolve({ error: null }));

    const recorded = await recordUsageSnapshot('tenant-1');

    expect(recorded).toBe(12);
    expect(insertMock).toHaveBeenCalledWith('usage_snapshots', { funded_accounts_monitored: 12 });
  });
});
