import { logWarn } from '@/lib/logging/logger';

/**
 * Live-provider health probe gating the reviewer agent.
 *
 * The legacy single-vendor integration was removed; until a live provider adapter is
 * wired into src/lib/platform/client.ts there is nothing to probe, so this
 * returns false and the reviewer agent defers its run.
 */
export async function isPlatformHealthy(): Promise<boolean> {
  logWarn('Platform health check: no live provider configured', { category: 'external_api' });
  return false;
}
