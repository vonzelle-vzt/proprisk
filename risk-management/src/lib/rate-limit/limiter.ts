import { getRedisClient } from '@/lib/redis/client';

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  reset_at: number;
}

// In-memory fallback for when Redis is unavailable
const memoryStore = new Map<string, { count: number; windowStart: number }>();

async function checkRedisRateLimit(
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult | null> {
  const redis = getRedisClient();
  if (!redis) return null;

  try {
    const redisKey = `rl:${key}`;
    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.pexpire(redisKey, config.windowMs);
    }
    const ttl = await redis.pttl(redisKey);
    const reset_at = Date.now() + Math.max(ttl, 0);
    const remaining = Math.max(0, config.maxRequests - count);
    return { allowed: count <= config.maxRequests, remaining, reset_at };
  } catch {
    return null;
  }
}

function checkMemoryRateLimit(
  key: string,
  config: RateLimitConfig
): RateLimitResult {
  const now = Date.now();
  const entry = memoryStore.get(key);

  if (!entry || now - entry.windowStart >= config.windowMs) {
    memoryStore.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: config.maxRequests - 1, reset_at: now + config.windowMs };
  }

  entry.count++;
  const remaining = Math.max(0, config.maxRequests - entry.count);
  const reset_at = entry.windowStart + config.windowMs;
  return { allowed: entry.count <= config.maxRequests, remaining, reset_at };
}

export async function checkRateLimit(
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const redisResult = await checkRedisRateLimit(key, config);
  if (redisResult) return redisResult;
  return checkMemoryRateLimit(key, config);
}

export function rateLimitResponse(result: RateLimitResult): Response {
  return Response.json(
    { error: 'Too many requests' },
    {
      status: 429,
      headers: {
        'Retry-After': String(Math.ceil((result.reset_at - Date.now()) / 1000)),
        'X-RateLimit-Remaining': String(result.remaining),
      },
    }
  );
}
