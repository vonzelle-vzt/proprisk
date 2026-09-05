import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

function fakeSingle(result: { data?: unknown; error?: unknown }) {
  return { maybeSingle: () => Promise.resolve(result) };
}

const tenantSelectMock = vi.fn();
const tenantInsertMock = vi.fn();
const tenantUpdateMock = vi.fn();
const tenantDeleteMock = vi.fn();
const globalTableSelectMock = vi.fn();

vi.mock('@/lib/db/tenant-scoped', () => ({
  tenantDb: (tenantId: string) => ({
    tenantId,
    select: (...args: unknown[]) => tenantSelectMock(...args),
    insert: (...args: unknown[]) => tenantInsertMock(...args),
    update: (...args: unknown[]) => tenantUpdateMock(...args),
    delete: (...args: unknown[]) => tenantDeleteMock(...args),
  }),
  globalTable: (table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: () => globalTableSelectMock(table),
      }),
    }),
  }),
}));

vi.mock('./metering', () => ({
  countFundedAccountsMonitored: vi.fn(),
}));

import { countFundedAccountsMonitored } from './metering';
import { checkEntitlement, canOnboardNewAccount, formatEntitlementWarning } from './entitlements';

const countMock = vi.mocked(countFundedAccountsMonitored);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkEntitlement', () => {
  it('reports within-limit usage as onboardable', async () => {
    tenantSelectMock.mockReturnValueOnce(fakeSingle({ data: { plan_tier: 'starter' } }));
    countMock.mockResolvedValueOnce(10);

    const status = await checkEntitlement('tenant-1');

    expect(status).toMatchObject({
      planTier: 'starter',
      limit: 25,
      used: 10,
      withinLimit: true,
      canOnboardNewAccount: true,
      overBy: 0,
    });
  });

  it('blocks onboarding exactly at the ceiling, without reporting an overage', async () => {
    tenantSelectMock.mockReturnValueOnce(fakeSingle({ data: { plan_tier: 'starter' } }));
    countMock.mockResolvedValueOnce(25);

    const status = await checkEntitlement('tenant-1');

    expect(status.withinLimit).toBe(true); // at the cap is not YET over it
    expect(status.canOnboardNewAccount).toBe(false); // but there is no room for one more
    expect(status.overBy).toBe(0);
  });

  it('reports an overage (e.g. after a downgrade) without ever calling a write', async () => {
    tenantSelectMock.mockReturnValueOnce(fakeSingle({ data: { plan_tier: 'starter' } }));
    countMock.mockResolvedValueOnce(30);

    const status = await checkEntitlement('tenant-1');

    expect(status).toMatchObject({
      withinLimit: false,
      canOnboardNewAccount: false,
      overBy: 5,
    });
    // THE machine-checkable proof for "must never stop monitoring": going
    // over the limit computes a status object only. No insert/update/delete
    // is ever invoked by this module, so there is no code path here that
    // could touch an existing account's monitoring state.
    expect(tenantInsertMock).not.toHaveBeenCalled();
    expect(tenantUpdateMock).not.toHaveBeenCalled();
    expect(tenantDeleteMock).not.toHaveBeenCalled();
  });

  it('falls back to the tenant\'s nominal plan_tier when no subscription row exists yet', async () => {
    tenantSelectMock.mockReturnValueOnce(fakeSingle({ data: null }));
    globalTableSelectMock.mockReturnValueOnce(Promise.resolve({ data: { plan_tier: 'growth' }, error: null }));
    countMock.mockResolvedValueOnce(5);

    const status = await checkEntitlement('tenant-1');

    expect(status.planTier).toBe('growth');
    expect(status.limit).toBe(100);
  });

  it('never blocks an enterprise (unlimited) plan, no matter the usage', async () => {
    tenantSelectMock.mockReturnValueOnce(fakeSingle({ data: { plan_tier: 'enterprise' } }));
    countMock.mockResolvedValueOnce(50_000);

    const status = await checkEntitlement('tenant-1');

    expect(status.limit).toBeNull();
    expect(status.withinLimit).toBe(true);
    expect(status.canOnboardNewAccount).toBe(true);
    expect(status.overBy).toBe(0);
  });
});

describe('canOnboardNewAccount', () => {
  it('returns false once a tenant is at its ceiling', async () => {
    tenantSelectMock.mockReturnValueOnce(fakeSingle({ data: { plan_tier: 'starter' } }));
    countMock.mockResolvedValueOnce(25);

    await expect(canOnboardNewAccount('tenant-1')).resolves.toBe(false);
  });
});

describe('formatEntitlementWarning', () => {
  it('returns null when there is nothing to warn about', () => {
    expect(
      formatEntitlementWarning({
        tenantId: 't',
        planTier: 'starter',
        limit: 25,
        used: 10,
        withinLimit: true,
        canOnboardNewAccount: true,
        overBy: 0,
      })
    ).toBeNull();
  });

  it('warns without implying monitoring will stop', () => {
    const message = formatEntitlementWarning({
      tenantId: 't',
      planTier: 'starter',
      limit: 25,
      used: 30,
      withinLimit: false,
      canOnboardNewAccount: false,
      overBy: 5,
    });

    expect(message).toMatch(/keep being monitored/i);
    expect(message).not.toMatch(/stop|suspend|disable/i);
  });
});

describe('graceful degradation is structural, not incidental', () => {
  it('the entitlements module source contains no mutation of account monitoring state', () => {
    const source = readFileSync(join(__dirname, 'entitlements.ts'), 'utf8');

    // No write verbs against the database at all — this module only reads.
    expect(source).not.toMatch(/\.update\s*\(/);
    expect(source).not.toMatch(/\.delete\s*\(/);
    expect(source).not.toMatch(/\.upsert\s*\(/);
    // No code path that could flip an account's active/monitored state.
    expect(source).not.toMatch(/is_active/);
    expect(source).not.toMatch(/suspend|disable|deactivate/i);
  });
});
