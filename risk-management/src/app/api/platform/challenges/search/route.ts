export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import {
  getCachedAccount,
  analyzeAccount,
  saveToCacheDB,
} from '@/lib/challenges/cache';
import { searchAccountsByLogin, PlatformNotConfiguredError } from '@/lib/platform/client';
import { requireRiskUser } from '@/lib/auth/guards';

const PHASES = [1, 2, 3];

/**
 * Search for a specific account. Checks cache first,
 * if not found searches the provider platform API, analyzes, and caches.
 */
export async function GET(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') {
    return Response.json({ data: null, source: 'not_found' }, { status: 404 });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const query = request.nextUrl.searchParams.get('q')?.trim();
  if (!query) {
    return Response.json({ error: 'Missing search query (?q=)' }, { status: 400 });
  }

  // Check if already cached
  const cached = await getCachedAccount(query);
  if (cached) {
    return Response.json({ data: cached, source: 'cache' });
  }

  // Not cached: search the live provider via the platform facade.
  try {
    const results = await searchAccountsByLogin(query, auth.tenantId);
    const acct = results.find((r) => PHASES.includes(r.phase));

    if (acct) {
      const analyzed = await analyzeAccount(acct, auth.tenantId);
      if (analyzed) {
        await saveToCacheDB([analyzed]);
        return Response.json({ data: analyzed, source: 'live' });
      }
    }
  } catch (err) {
    if (err instanceof PlatformNotConfiguredError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
  }

  return Response.json({ data: null, source: 'not_found' }, { status: 404 });
}
