import { getRedisClient } from '@/lib/redis/client';

/**
 * Generic cache-aside helper for provider/adapter calls (live-mode network
 * fetches that are safe to cache for a few seconds/minutes). Backed by
 * Upstash Redis when configured (`src/lib/redis/client.ts`); falls back to a
 * module-level in-memory Map with expiry when Redis is unconfigured or
 * errors, so callers never need to branch on availability.
 *
 * Not wired into any route yet — feature builders opt individual fetches in.
 */

interface MemEntry {
  value: string;
  expiresAt: number;
}

/**
 * Cap on the in-memory fallback cache. Callers key on user-controlled values
 * (e.g. history/summary keys on requested date ranges), so an uncapped Map is
 * an unbounded-growth vector. A Map preserves insertion order, so the oldest
 * key is always `keys().next()` — evict it (LRU) when full.
 */
const MEM_CACHE_MAX = 200;

const memCache = new Map<string, MemEntry>();

function memGet(key: string): string | null {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memCache.delete(key);
    return null;
  }
  // LRU touch: re-insert so this key becomes the most-recently-used.
  memCache.delete(key);
  memCache.set(key, entry);
  return entry.value;
}

function memSet(key: string, value: string, ttlSec: number): void {
  // Refresh recency if present; otherwise evict the LRU entry when at capacity.
  if (memCache.has(key)) {
    memCache.delete(key);
  } else if (memCache.size >= MEM_CACHE_MAX) {
    const oldest = memCache.keys().next().value;
    if (oldest !== undefined) memCache.delete(oldest);
  }
  memCache.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
}

function memInvalidate(keyPrefix: string): void {
  for (const key of memCache.keys()) {
    if (key.startsWith(keyPrefix)) memCache.delete(key);
  }
}

/**
 * Fetch `key` from cache, or compute it with `fn()` and cache the result for
 * `ttlSec` seconds. Values are JSON-serialized. Redis errors fall through to
 * calling `fn()` directly (never block on a broken cache).
 */
export async function cachedFetch<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> {
  const redis = getRedisClient();

  if (redis) {
    try {
      const cached = await redis.get<string>(key);
      if (cached != null) {
        return (typeof cached === 'string' ? JSON.parse(cached) : cached) as T;
      }
    } catch (err) {
      console.error('[provider-cache] redis get failed, falling through', err);
    }
  } else {
    const cached = memGet(key);
    if (cached != null) return JSON.parse(cached) as T;
  }

  const value = await fn();

  if (redis) {
    try {
      await redis.set(key, JSON.stringify(value), { ex: ttlSec });
    } catch (err) {
      console.error('[provider-cache] redis set failed', err);
    }
  } else {
    memSet(key, JSON.stringify(value), ttlSec);
  }

  return value;
}

/** Invalidate every cached entry whose key starts with `keyPrefix`. */
export async function invalidate(keyPrefix: string): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    try {
      // Upstash REST client supports SCAN via keys(); acceptable for the
      // low-cardinality provider-cache key space this is used for.
      const keys = await redis.keys(`${keyPrefix}*`);
      if (keys.length > 0) await redis.del(...keys);
    } catch (err) {
      console.error('[provider-cache] redis invalidate failed', err);
    }
  }
  memInvalidate(keyPrefix);
}
