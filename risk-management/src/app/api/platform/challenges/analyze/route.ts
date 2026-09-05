export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import { NextRequest } from 'next/server';
import {
  getCachedAccount,
  analyzeAccount,
  saveToCacheDB,
  type CachedChallengeAccount,
} from '@/lib/challenges/cache';
import {
  fetchAccountDetails,
  fetchUserDetails,
  fetchAccountTradeData,
  type ChallengeAccountSearchResult,
} from '@/lib/platform/client';
import { fetchEventsForDateRange } from '@/lib/news/calendar';
import { upsertNewsEvents } from '@/lib/news/db';
import { requireRiskUser } from '@/lib/auth/guards';

/**
 * On-demand analysis: fetches trades, analyzes for violations, caches result.
 * For Pro/Flex (type 2/3), also analyzes the Phase 1 account via parentId.
 */
export async function POST(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') {
    const body = await request.json().catch(() => ({}));
    const { accountId } = body as { accountId?: string };
    if (!accountId) {
      return Response.json({ error: 'Missing accountId' }, { status: 400 });
    }
    const { buildChallengeAnalysis } = await import('@/lib/mock/builders');
    return Response.json(buildChallengeAnalysis(String(accountId)));
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;
  const tenantId = auth.tenantId;

  try {
    const body = await request.json();
    const { accountId, type, parentId, recheckNews, forceRevalidate } = body as {
      accountId: string;
      type: number;
      parentId?: number;
      recheckNews?: boolean;
      forceRevalidate?: boolean;
    };

    if (!accountId) {
      return Response.json({ error: 'Missing accountId' }, { status: 400 });
    }

    // Check cache for the primary account (skip if forcing revalidation)
    const skipCache = forceRevalidate || recheckNews;
    const cached = skipCache ? null : await getCachedAccount(accountId);
    let cachedPhase1: CachedChallengeAccount | null = null;
    if (parentId && !skipCache) {
      cachedPhase1 = await getCachedAccount(parentId.toString());
    }

    // If both are cached, return immediately
    if (cached && (!parentId || cachedPhase1)) {
      return Response.json({
        phase2: cached,
        phase1: cachedPhase1,
        source: 'cache',
      });
    }

    // Fetch account details from the provider platform API
    const acctDetails = await fetchAccountDetails(accountId, tenantId);
    if (!acctDetails) {
      return Response.json({ error: 'Account not found' }, { status: 404 });
    }

    // Fetch user info for email (needed for trade analysis via foreign session)
    let email = '', firstName = '', lastName = '', country = '';
    if (acctDetails.userId) {
      const user = await fetchUserDetails(acctDetails.userId, tenantId);
      if (user) {
        email = user.email || '';
        firstName = user.firstName || '';
        lastName = user.lastName || '';
        country = user.country || '';
      }
    }

    // Build ChallengeAccountSearchResult for analyzeAccount
    const toSearchResult = (d: typeof acctDetails, overrides?: Partial<ChallengeAccountSearchResult>): ChallengeAccountSearchResult => ({
      login: d.login,
      accountId: d.accountId,
      userId: d.userId,
      planName: d.planName || '',
      type: d.type || type,
      status: d.status || 3,
      phase: d.phase || 1,
      startingBalance: d.startingBalance || 0,
      lastBalance: d.lastBalance || 0,
      lastEquity: d.lastEquity || 0,
      priorDayBalance: d.priorDayBalance || 0,
      priorDayEquity: d.priorDayEquity || 0,
      tradedDays: d.tradedDays || 0,
      banNewsTrading: d.banNewsTrading || 0,
      banHFT: d.banHFT || 0,
      banMTGL: d.banMTGL || 0,
      consistencyPct: d.consistencyPct || 0,
      _curConsistencyPct: d._curConsistencyPct || 0,
      numApprovedPayouts: d.numApprovedPayouts || 0,
      approvedPayouts: d.approvedPayouts || 0,
      email,
      firstName,
      lastName,
      country,
      parentId: null,
      childId: null,
      addedUTC: d.addedUTC || '',
      lastUpdatedUTC: d.lastUpdatedUTC || '',
      disabled: d.disabled || 0,
      ...overrides,
    });

    // If recheckNews, fetch live news events and persist to DB before analysis
    if (recheckNews && email) {
      try {
        const tradeData = await fetchAccountTradeData(accountId, email, tenantId);
        if (tradeData && tradeData.trades.length > 0) {
          const tradeTimes = tradeData.trades.map((t: any) => new Date(t.openTime).getTime());
          const rangeStart = new Date(Math.min(...tradeTimes));
          rangeStart.setUTCHours(0, 0, 0, 0);
          const rangeEnd = new Date(Math.max(...tradeTimes));
          rangeEnd.setUTCHours(23, 59, 59, 999);
          const liveEvents = await fetchEventsForDateRange(rangeStart, rangeEnd);
          if (liveEvents.length > 0) await upsertNewsEvents(liveEvents);
        }
      } catch {
        // Live fetch failed — continue with existing DB data
      }
    }

    // Analyze the primary account (Phase 2 for Pro/Flex, Phase 1 for One Phase)
    // Skip cache when recheckNews or forceRevalidate is requested
    let phase2Result: CachedChallengeAccount | null = skipCache ? null : cached;
    if (!phase2Result) {
      phase2Result = await analyzeAccount(toSearchResult(acctDetails), tenantId);
      if (phase2Result) {
        await saveToCacheDB([phase2Result]);
      }
    }

    // Analyze Phase 1 if Pro/Flex
    let phase1Result: CachedChallengeAccount | null = cachedPhase1;
    if (parentId && !cachedPhase1) {
      const phase1Details = await fetchAccountDetails(parentId.toString(), tenantId);
      if (phase1Details) {
        phase1Result = await analyzeAccount(toSearchResult(phase1Details, { phase: 1 }), tenantId);
        if (phase1Result) {
          await saveToCacheDB([phase1Result]);
        }
      }
    }

    return Response.json({
      phase2: phase2Result,
      phase1: phase1Result,
      source: cached ? 'cache' : 'live',
    });
  } catch (err) {
    console.error('[challenges/analyze] Error:', err);
    return Response.json(
      { error: 'Analysis failed', message: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
