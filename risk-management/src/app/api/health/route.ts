export const dynamic = 'force-dynamic';

import { validateEnv } from '@/lib/env/validate';
import { createAdminClient } from '@/lib/supabase/admin';
import { getRedisClient } from '@/lib/redis/client';

type CheckStatus = 'pass' | 'fail' | 'skip';

interface CheckResult {
  status: CheckStatus;
  latency_ms?: number;
  error?: string;
  missing?: string[];
}

async function checkEnv(): Promise<CheckResult> {
  const result = validateEnv();
  return result.valid
    ? { status: 'pass' }
    : { status: 'fail', missing: result.missing };
}

async function checkSupabase(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const supabase = createAdminClient();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const { error } = await supabase
      .from('audit_log')
      .select('id')
      .limit(1)
      .abortSignal(controller.signal);
    clearTimeout(timeout);
    if (error) return { status: 'fail', latency_ms: Date.now() - start, error: error.message };
    return { status: 'pass', latency_ms: Date.now() - start };
  } catch (err) {
    return { status: 'fail', latency_ms: Date.now() - start, error: err instanceof Error ? err.message : 'Unknown' };
  }
}

async function checkRedis(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const redis = getRedisClient();
    if (!redis) return { status: 'skip' };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    await redis.ping();
    clearTimeout(timeout);
    return { status: 'pass', latency_ms: Date.now() - start };
  } catch (err) {
    return { status: 'fail', latency_ms: Date.now() - start, error: err instanceof Error ? err.message : 'Unknown' };
  }
}

export async function GET() {
  // Demo deployments have no real backends; healthy = serving pages.
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') {
    return Response.json(
      { status: 'healthy', demo: true, timestamp: new Date().toISOString(), checks: {} },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } }
    );
  }

  const [env, supabase, redis] = await Promise.allSettled([
    checkEnv(),
    checkSupabase(),
    checkRedis(),
  ]);

  const checks: Record<string, CheckResult> = {
    env: env.status === 'fulfilled' ? env.value : { status: 'fail', error: 'Check threw' },
    supabase: supabase.status === 'fulfilled' ? supabase.value : { status: 'fail', error: 'Check threw' },
    redis: redis.status === 'fulfilled' ? redis.value : { status: 'fail', error: 'Check threw' },
  };

  const criticalFailed = checks.env.status === 'fail' ||
    checks.supabase.status === 'fail';

  const anyFailed = Object.values(checks).some((c) => c.status === 'fail');

  const status = criticalFailed ? 'unhealthy' : anyFailed ? 'degraded' : 'healthy';

  return Response.json(
    {
      status,
      timestamp: new Date().toISOString(),
      checks,
    },
    {
      status: status === 'unhealthy' ? 503 : 200,
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    }
  );
}
