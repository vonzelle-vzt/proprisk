import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lpop = vi.fn();
const llen = vi.fn();

const redisMock = { lpop, llen };
const getRedisClientMock = vi.fn(() => redisMock);

vi.mock('@/lib/redis/client', () => ({
  getRedisClient: () => getRedisClientMock(),
}));

describe('queue/violations — per-tenant key namespacing', () => {
  beforeEach(() => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'token');
    lpop.mockReset();
    llen.mockReset();
    getRedisClientMock.mockReturnValue(redisMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('dequeues from a key namespaced to the given tenant, never the bare global key', async () => {
    const { dequeueViolationJob } = await import('./violations');
    lpop.mockResolvedValue(null);

    await dequeueViolationJob('tenant-a');

    expect(lpop).toHaveBeenCalledWith('queue:violations:pending:tenant-a');
  });

  it('uses a different key per tenant, so one tenant can never drain another tenant\'s queue', async () => {
    const { dequeueViolationJob } = await import('./violations');
    lpop.mockResolvedValue(null);

    await dequeueViolationJob('tenant-a');
    await dequeueViolationJob('tenant-b');

    const keysUsed = lpop.mock.calls.map((call) => call[0]);
    expect(new Set(keysUsed).size).toBe(2);
    expect(keysUsed).toContain('queue:violations:pending:tenant-a');
    expect(keysUsed).toContain('queue:violations:pending:tenant-b');
  });

  it('reports queue depth per tenant key', async () => {
    const { getViolationQueueDepth } = await import('./violations');
    llen.mockResolvedValue(3);

    const depth = await getViolationQueueDepth('tenant-a');

    expect(depth).toBe(3);
    expect(llen).toHaveBeenCalledWith('queue:violations:pending:tenant-a');
  });
});
