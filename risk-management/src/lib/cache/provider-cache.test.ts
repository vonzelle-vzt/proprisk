import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getRedisClientMock = vi.fn();

vi.mock('@/lib/redis/client', () => ({
  getRedisClient: () => getRedisClientMock(),
}));

import { cachedFetch, invalidate } from './provider-cache';

describe('cachedFetch — in-memory fallback (no Redis configured)', () => {
  beforeEach(() => {
    getRedisClientMock.mockReturnValue(null);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('caches the computed value and does not re-invoke fn() within the TTL', async () => {
    const fn = vi.fn().mockResolvedValue({ value: 42 });
    const key = 'mem-key-1';

    const first = await cachedFetch(key, 60, fn);
    const second = await cachedFetch(key, 60, fn);

    expect(first).toEqual({ value: 42 });
    expect(second).toEqual({ value: 42 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('re-invokes fn() once the TTL has expired', async () => {
    const fn = vi.fn().mockResolvedValueOnce({ value: 1 }).mockResolvedValueOnce({ value: 2 });
    const key = 'mem-key-2';

    const first = await cachedFetch(key, 10, fn);
    expect(first).toEqual({ value: 1 });

    vi.advanceTimersByTime(11 * 1000);

    const second = await cachedFetch(key, 10, fn);
    expect(second).toEqual({ value: 2 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('caps the in-memory cache at 200 entries, evicting the least-recently-used', async () => {
    // Fill the cache to its cap with 200 distinct keys.
    for (let i = 0; i < 200; i++) {
      await cachedFetch(`lru-key-${i}`, 60, vi.fn().mockResolvedValue(i));
    }

    // Touch key 0 so it becomes most-recently-used (key 1 is now the LRU).
    const touch0 = vi.fn().mockResolvedValue('should-not-run');
    await cachedFetch('lru-key-0', 60, touch0);
    expect(touch0).not.toHaveBeenCalled(); // still cached (a hit)

    // Insert one more key -> forces a single eviction of the LRU entry (key 1).
    await cachedFetch('lru-key-200', 60, vi.fn().mockResolvedValue(200));

    // key 1 was evicted -> fn re-invoked on next fetch.
    const refetch1 = vi.fn().mockResolvedValue('recomputed');
    const v1 = await cachedFetch('lru-key-1', 60, refetch1);
    expect(refetch1).toHaveBeenCalledTimes(1);
    expect(v1).toBe('recomputed');

    // key 0 survived (it was touched) -> still a cache hit, fn not called.
    const refetch0 = vi.fn().mockResolvedValue('recomputed-0');
    const v0 = await cachedFetch('lru-key-0', 60, refetch0);
    expect(refetch0).not.toHaveBeenCalled();
    expect(v0).toBe(0);
  });

  it('invalidate(prefix) removes only keys matching that prefix', async () => {
    const fnA = vi.fn().mockResolvedValue('a');
    const fnB = vi.fn().mockResolvedValue('b');

    await cachedFetch('provider:matchtrader:accounts', 60, fnA);
    await cachedFetch('provider:tradovate:accounts', 60, fnB);

    await invalidate('provider:matchtrader:');

    // matchtrader entry was invalidated -> fn re-invoked
    await cachedFetch('provider:matchtrader:accounts', 60, fnA);
    expect(fnA).toHaveBeenCalledTimes(2);

    // tradovate entry untouched -> fn NOT re-invoked
    await cachedFetch('provider:tradovate:accounts', 60, fnB);
    expect(fnB).toHaveBeenCalledTimes(1);
  });
});

describe('cachedFetch — Redis path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the cached JSON value from redis.get without calling fn()', async () => {
    const fn = vi.fn();
    const redis = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ cached: true })),
      set: vi.fn(),
      keys: vi.fn(),
      del: vi.fn(),
    };
    getRedisClientMock.mockReturnValue(redis);

    const result = await cachedFetch('redis-key', 30, fn);
    expect(result).toEqual({ cached: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it('calls fn() and writes through to redis.set on a cache miss', async () => {
    const fn = vi.fn().mockResolvedValue({ fresh: true });
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn(),
      del: vi.fn(),
    };
    getRedisClientMock.mockReturnValue(redis);

    const result = await cachedFetch('redis-key-miss', 30, fn);
    expect(result).toEqual({ fresh: true });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith('redis-key-miss', JSON.stringify({ fresh: true }), { ex: 30 });
  });

  it('falls through to fn() when redis.get throws', async () => {
    const fn = vi.fn().mockResolvedValue({ recovered: true });
    const redis = {
      get: vi.fn().mockRejectedValue(new Error('redis down')),
      set: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn(),
      del: vi.fn(),
    };
    getRedisClientMock.mockReturnValue(redis);

    const result = await cachedFetch('redis-key-err', 30, fn);
    expect(result).toEqual({ recovered: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not throw when redis.set fails after a successful fn() call', async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true });
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockRejectedValue(new Error('redis set failed')),
      keys: vi.fn(),
      del: vi.fn(),
    };
    getRedisClientMock.mockReturnValue(redis);

    await expect(cachedFetch('redis-key-set-fail', 30, fn)).resolves.toEqual({ ok: true });
  });

  it('invalidate() deletes matching keys via redis.keys/redis.del and swallows errors', async () => {
    const redisOk = {
      get: vi.fn(),
      set: vi.fn(),
      keys: vi.fn().mockResolvedValue(['provider:matchtrader:a', 'provider:matchtrader:b']),
      del: vi.fn().mockResolvedValue(2),
    };
    getRedisClientMock.mockReturnValue(redisOk);
    await invalidate('provider:matchtrader:');
    expect(redisOk.keys).toHaveBeenCalledWith('provider:matchtrader:*');
    expect(redisOk.del).toHaveBeenCalledWith('provider:matchtrader:a', 'provider:matchtrader:b');

    const redisErr = {
      get: vi.fn(),
      set: vi.fn(),
      keys: vi.fn().mockRejectedValue(new Error('scan failed')),
      del: vi.fn(),
    };
    getRedisClientMock.mockReturnValue(redisErr);
    await expect(invalidate('provider:tradovate:')).resolves.toBeUndefined();
  });
});
