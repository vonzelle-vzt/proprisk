import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/tenant-scoped', () => ({
  listActiveTenantIds: vi.fn(),
}));

vi.mock('@/lib/logging/logger', () => ({
  logError: vi.fn(),
}));

describe('fanOutToTenants', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('runs the job once per active tenant and reports tenant-scoped results', async () => {
    const { listActiveTenantIds } = await import('@/lib/db/tenant-scoped');
    (listActiveTenantIds as any).mockResolvedValue(['tenant-a', 'tenant-b', 'tenant-c']);

    const { fanOutToTenants } = await import('./fanout');

    const seen: string[] = [];
    const outcomes = await fanOutToTenants(
      async (tenantId: string) => {
        seen.push(tenantId);
        return { tenantId, value: 42 };
      },
      { jobName: 'test-job' }
    );

    // Every tenant got its own call, and the fn received exactly that
    // tenant's id — no query is ever unscoped across tenants.
    expect(seen.sort()).toEqual(['tenant-a', 'tenant-b', 'tenant-c']);
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(true);
      expect(outcome.result?.tenantId).toBe(outcome.tenant_id);
      expect(outcome.result?.value).toBe(42);
    }
  });

  it('does not let one tenant failure abort the batch — the rest still complete and are reported', async () => {
    const { listActiveTenantIds } = await import('@/lib/db/tenant-scoped');
    (listActiveTenantIds as any).mockResolvedValue(['tenant-a', 'tenant-b', 'tenant-c']);

    const { fanOutToTenants } = await import('./fanout');
    const { logError } = await import('@/lib/logging/logger');

    const outcomes = await fanOutToTenants(
      async (tenantId: string) => {
        if (tenantId === 'tenant-b') throw new Error('boom for tenant-b');
        return 'ok';
      },
      { jobName: 'test-job' }
    );

    expect(outcomes).toHaveLength(3);

    const byTenant = new Map(outcomes.map((o) => [o.tenant_id, o]));
    expect(byTenant.get('tenant-a')).toMatchObject({ ok: true, result: 'ok' });
    expect(byTenant.get('tenant-c')).toMatchObject({ ok: true, result: 'ok' });

    const failed = byTenant.get('tenant-b')!;
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('boom for tenant-b');

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('test-job'),
      expect.any(Error),
      expect.objectContaining({ tenant_id: 'tenant-b' })
    );
  });

  it('bounds concurrency — never runs more than `concurrency` tenant jobs at once', async () => {
    const { listActiveTenantIds } = await import('@/lib/db/tenant-scoped');
    const tenantIds = Array.from({ length: 7 }, (_, i) => `tenant-${i}`);
    (listActiveTenantIds as any).mockResolvedValue(tenantIds);

    const { fanOutToTenants } = await import('./fanout');

    let inFlight = 0;
    let maxInFlight = 0;

    await fanOutToTenants(
      async (tenantId: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return tenantId;
      },
      { jobName: 'test-job', concurrency: 2 }
    );

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
