export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import {
  fetchPassedChallengeAccounts,
  fetchAccountDetails,
  fetchUserDetails,
  searchAccountsByEmail,
  searchAccountsByLogin,
  type ChallengeAccountSearchResult,
} from '@/lib/platform/client';
import {
  getCachedAccountIds,
  getCachedAccounts,
  getCachedAccountStats,
  getCachedAccount,
  analyzeAccount,
  saveToCacheDB,
  type CachedChallengeAccount,
} from '@/lib/challenges/cache';
import { requireRiskUser } from '@/lib/auth/guards';

const TYPE_LABELS: Record<number, string> = { 1: 'One Phase', 2: 'Pro', 3: 'Flex', 4: 'Instant', 5: 'Instant Pro' };

function isPassedAccount(acct: { type: number; phase: number; status: number }): boolean {
  if (acct.status !== 3) return false;
  const isOnePhase = acct.type === 1 && acct.phase === 1;
  const isProFlexPhase2 = (acct.type === 2 || acct.type === 3) && acct.phase === 2;
  return isOnePhase || isProFlexPhase2;
}

function formatCachedAsAccount(c: CachedChallengeAccount) {
  return {
    accountId: parseInt(c.account_id) || c.account_id,
    login: parseInt(c.login) || c.login,
    userId: 0,
    email: c.email || '',
    firstName: c.first_name || '',
    lastName: c.last_name || '',
    country: c.country || '',
    planName: c.plan || '',
    type: c.plan_type === 'One Phase' ? 1 : c.plan_type === 'Pro' ? 2 : c.plan_type === 'Flex' ? 3 : 0,
    typeLabel: c.plan_type || '',
    phase: c.phase,
    startingBalance: c.starting_balance || 0,
    lastBalance: c.balance || 0,
    lastEquity: c.equity || 0,
    tradedDays: c.traded_days || 0,
    banNewsTrading: c.ban_news_trading,
    banHFT: c.ban_hft,
    banMTGL: c.ban_mtgl,
    parentId: null,
    childId: null,
    addedUTC: c.added_at || '',
    analysisStatus: 'cached' as const,
    phase1: null as null,
  };
}

function formatApiAccount(
  acct: ChallengeAccountSearchResult,
  cachedIds: Set<string>,
  phase1?: ChallengeAccountSearchResult | null,
) {
  return {
    accountId: acct.accountId,
    login: acct.login,
    userId: acct.userId,
    email: acct.email || '',
    firstName: acct.firstName || '',
    lastName: acct.lastName || '',
    country: acct.country || '',
    planName: acct.planName || '',
    type: acct.type,
    typeLabel: TYPE_LABELS[acct.type] || String(acct.type),
    phase: acct.phase,
    startingBalance: acct.startingBalance || 0,
    lastBalance: acct.lastBalance || 0,
    lastEquity: acct.lastEquity || 0,
    tradedDays: acct.tradedDays || 0,
    banNewsTrading: acct.banNewsTrading === 1,
    banHFT: acct.banHFT === 1,
    banMTGL: acct.banMTGL === 1,
    parentId: acct.parentId,
    childId: acct.childId,
    addedUTC: acct.addedUTC || '',
    analysisStatus: cachedIds.has(acct.accountId.toString()) ? 'cached' as const : 'not_analyzed' as const,
    phase1: phase1 ? {
      accountId: phase1.accountId,
      login: phase1.login,
      planName: phase1.planName,
      startingBalance: phase1.startingBalance || 0,
      lastBalance: phase1.lastBalance || 0,
      lastEquity: phase1.lastEquity || 0,
      tradedDays: phase1.tradedDays || 0,
      lastUpdatedUTC: phase1.lastUpdatedUTC || '',
      analysisStatus: cachedIds.has(phase1.accountId.toString()) ? 'cached' as const : 'not_analyzed' as const,
    } : null,
  };
}

const VIOLATION_TYPE_LABELS: Record<string, string> = {
  overleveraging: 'Overleveraging',
  hft: 'HFT',
  martingale: 'Martingale',
  news: 'News Trading',
  grid: 'Grid Trading',
  copy: 'Copy Trading',
  violations: 'Violations',
  overnight: 'Overnight',
};

async function getGlobalStats() {
  const allCached = await getCachedAccountStats();

  // Build per-type violation breakdown
  const typeMap = new Map<string, { label: string; count: number; amount: number }>();
  for (const a of allCached) {
    for (const [type, amount] of Object.entries(a.deduction_breakdown || {})) {
      if (amount <= 0) continue;
      if (type === 'profit_cap' || type === '2_percent_cap') continue;
      const existing = typeMap.get(type);
      if (existing) {
        existing.count++;
        existing.amount += amount;
      } else {
        typeMap.set(type, { label: VIOLATION_TYPE_LABELS[type] || type, count: 1, amount });
      }
    }
  }
  const violationBreakdown = Array.from(typeMap.entries())
    .map(([type, d]) => ({ type, ...d }))
    .sort((a, b) => b.amount - a.amount);

  return {
    analyzedCount: allCached.length,
    withViolations: allCached.filter((a) => a.total_deductions > 0).length,
    totalDeductions: allCached.reduce((s, a) => s + a.total_deductions, 0),
    violationBreakdown,
  };
}

export async function GET(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') {
    const sp = request.nextUrl.searchParams;
    const { buildChallengeDashboard } = await import('@/lib/mock/builders');
    return Response.json(buildChallengeDashboard(Number(sp.get('page')) || 1, sp.get('search') || ''));
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;
  const tenantId = auth.tenantId;

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const page = Math.max(1, parseInt(params.page || '1'));
  const pageSize = Math.min(100, Math.max(1, parseInt(params.pageSize || '25')));
  const search = params.search?.trim() || '';

  try {
    const stats = await getGlobalStats();
    const isNumeric = /^\d+$/.test(search);
    const isEmail = search.includes('@');

    // --- Numeric search: DB-first, then live-provider fallback ---
    if (search && isNumeric) {
      // 1. Check DB
      const dbResults = await getCachedAccounts({ search });
      if (dbResults.length > 0) {
        const accounts = dbResults.map(formatCachedAsAccount);
        return Response.json({
          accounts,
          page: 1,
          pageSize: accounts.length,
          hasMore: false,
          totalAccounts: accounts.length,
          stats,
          searchSource: 'cache',
        });
      }

      // 2. Not in DB — try direct accountId lookup, then search by login
      let acctDetails = await fetchAccountDetails(search, tenantId);

      // If direct lookup fails, try searching by login number
      if (!acctDetails) {
        const searchResults = await searchAccountsByLogin(search, tenantId);
        if (searchResults.length > 0) {
          // Use the first matching result — fetch full details by accountId
          acctDetails = await fetchAccountDetails(searchResults[0].accountId.toString(), tenantId);
        }
      }

      // 3. Check if the account is a passed challenge
      if (acctDetails) {
        const acctType = acctDetails.type || 0;
        const acctPhase = acctDetails.phase || 0;
        const acctStatus = acctDetails.status || 0;

        if (!isPassedAccount({ type: acctType, phase: acctPhase, status: acctStatus })) {
          // Still analyze for violations but don't save to DB
          let notPassedAnalysis: CachedChallengeAccount | null = null;
          let email = '', firstName = '', lastName = '', country = '';
          if (acctDetails.userId) {
            const user = await fetchUserDetails(String(acctDetails.userId), tenantId);
            if (user) {
              email = user.email || '';
              firstName = user.firstName || '';
              lastName = user.lastName || '';
              country = user.country || '';
            }
          }
          try {
            const searchResult: ChallengeAccountSearchResult = {
              login: acctDetails.login,
              accountId: acctDetails.accountId,
              userId: acctDetails.userId,
              planName: acctDetails.planName || '',
              type: acctType,
              status: acctStatus,
              phase: acctPhase,
              startingBalance: acctDetails.startingBalance || 0,
              lastBalance: acctDetails.lastBalance || 0,
              lastEquity: acctDetails.lastEquity || 0,
              priorDayBalance: acctDetails.priorDayBalance || 0,
              priorDayEquity: acctDetails.priorDayEquity || 0,
              tradedDays: acctDetails.tradedDays || 0,
              banNewsTrading: acctDetails.banNewsTrading || 0,
              banHFT: acctDetails.banHFT || 0,
              banMTGL: acctDetails.banMTGL || 0,
              consistencyPct: acctDetails.consistencyPct || 0,
              _curConsistencyPct: acctDetails._curConsistencyPct || 0,
              numApprovedPayouts: acctDetails.numApprovedPayouts || 0,
              approvedPayouts: acctDetails.approvedPayouts || 0,
              email, firstName, lastName, country,
              parentId: null, childId: null,
              addedUTC: acctDetails.addedUTC || '',
              lastUpdatedUTC: acctDetails.lastUpdatedUTC || '',
              disabled: acctDetails.disabled || 0,
            };
            notPassedAnalysis = await analyzeAccount(searchResult, tenantId);
          } catch {}

          return Response.json({
            accounts: [],
            page: 1,
            pageSize: 0,
            hasMore: false,
            totalAccounts: 0,
            stats,
            notPassed: true,
            notPassedDetails: {
              login: acctDetails.login,
              accountId: acctDetails.accountId,
              type: TYPE_LABELS[acctType] || String(acctType),
              phase: acctPhase,
              status: acctStatus,
            },
            notPassedAnalysis,
          });
        }

        // Passed — fetch user info, analyze, save
        let email = '', firstName = '', lastName = '', country = '';
        if (acctDetails.userId) {
          const user = await fetchUserDetails(String(acctDetails.userId), tenantId);
          if (user) {
            email = user.email || '';
            firstName = user.firstName || '';
            lastName = user.lastName || '';
            country = user.country || '';
          }
        }

        const searchResult: ChallengeAccountSearchResult = {
          login: acctDetails.login,
          accountId: acctDetails.accountId,
          userId: acctDetails.userId,
          planName: acctDetails.planName || '',
          type: acctType,
          status: acctStatus,
          phase: acctPhase,
          startingBalance: acctDetails.startingBalance || 0,
          lastBalance: acctDetails.lastBalance || 0,
          lastEquity: acctDetails.lastEquity || 0,
          priorDayBalance: acctDetails.priorDayBalance || 0,
          priorDayEquity: acctDetails.priorDayEquity || 0,
          tradedDays: acctDetails.tradedDays || 0,
          banNewsTrading: acctDetails.banNewsTrading || 0,
          banHFT: acctDetails.banHFT || 0,
          banMTGL: acctDetails.banMTGL || 0,
          consistencyPct: acctDetails.consistencyPct || 0,
          _curConsistencyPct: acctDetails._curConsistencyPct || 0,
          numApprovedPayouts: acctDetails.numApprovedPayouts || 0,
          approvedPayouts: acctDetails.approvedPayouts || 0,
          email,
          firstName,
          lastName,
          country,
          parentId: null,
          childId: null,
          addedUTC: acctDetails.addedUTC || '',
          lastUpdatedUTC: acctDetails.lastUpdatedUTC || '',
          disabled: acctDetails.disabled || 0,
        };

        // Analyze and save
        const analyzed = await analyzeAccount(searchResult, tenantId);
        if (analyzed) {
          await saveToCacheDB([analyzed]);
        }

        const cachedIds = new Set<string>([searchResult.accountId.toString()]);
        const accounts = [formatApiAccount(searchResult, cachedIds)];

        return Response.json({
          accounts,
          page: 1,
          pageSize: 1,
          hasMore: false,
          totalAccounts: 1,
          stats: await getGlobalStats(), // Re-fetch after save
          searchSource: 'platform',
        });
      }

      // Not found at all
      return Response.json({
        accounts: [],
        page: 1,
        pageSize: 0,
        hasMore: false,
        totalAccounts: 0,
        stats,
      });
    }

    // --- Email search: provider platform API with email param ---
    if (search && isEmail) {
      const apiResults = await searchAccountsByEmail(search, tenantId);

      // Filter for passed accounts only
      const passed = apiResults.filter((a) =>
        isPassedAccount({ type: a.type, phase: a.phase, status: a.status })
      );

      if (passed.length === 0) {
        return Response.json({
          accounts: [],
          page: 1,
          pageSize: 0,
          hasMore: false,
          totalAccounts: 0,
          stats,
          notPassed: apiResults.length > 0, // accounts exist but none passed
        });
      }

      const accountIds = passed.map((a) => a.accountId.toString());
      const parentIds = passed
        .filter((a) => (a.type === 2 || a.type === 3) && a.parentId)
        .map((a) => a.parentId!.toString());
      const allIds = [...accountIds, ...parentIds];
      const cachedIds = allIds.length > 0 ? await getCachedAccountIds(allIds) : new Set<string>();

      const accounts = passed.map((acct) => formatApiAccount(acct, cachedIds));

      return Response.json({
        accounts,
        page: 1,
        pageSize: accounts.length,
        hasMore: false,
        totalAccounts: accounts.length,
        stats,
        searchSource: 'platform',
        canCheckMore: true,
      });
    }

    // --- Default: paginated passed accounts from the provider platform ---
    const result = await fetchPassedChallengeAccounts({ page, pageSize }, tenantId);

    // Batch-check which accounts are already cached (analyzed)
    const accountIds = result.data.map((a) => a.accountId.toString());
    const parentIds = result.data
      .filter((a) => (a.type === 2 || a.type === 3) && a.parentId)
      .map((a) => a.parentId!.toString());
    const allIds = [...accountIds, ...parentIds];
    const cachedIds = allIds.length > 0 ? await getCachedAccountIds(allIds) : new Set<string>();

    // For Pro/Flex, fetch Phase 1 details via parentId (concurrency-limited)
    const CONCURRENCY = 5;
    const phase1Map = new Map<number, ChallengeAccountSearchResult | null>();
    const needsPhase1 = result.data.filter(
      (a) => (a.type === 2 || a.type === 3) && a.parentId
    );

    for (let i = 0; i < needsPhase1.length; i += CONCURRENCY) {
      const batch = needsPhase1.slice(i, i + CONCURRENCY);
      const details = await Promise.allSettled(
        batch.map((a) => fetchAccountDetails(a.parentId!.toString(), tenantId))
      );
      batch.forEach((a, idx) => {
        const r = details[idx];
        if (r.status === 'fulfilled' && r.value) {
          const d = r.value;
          phase1Map.set(a.parentId!, {
            login: d.login,
            accountId: d.accountId,
            userId: d.userId,
            planName: d.planName || '',
            type: d.type || a.type,
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
            email: '',
            firstName: '',
            lastName: '',
            country: '',
            parentId: null,
            childId: null,
            addedUTC: d.addedUTC || '',
            lastUpdatedUTC: d.lastUpdatedUTC || '',
            disabled: d.disabled || 0,
          } as ChallengeAccountSearchResult);
        } else {
          phase1Map.set(a.parentId!, null);
        }
      });
    }

    // Build response
    const accounts = result.data.map((acct) => {
      const phase1 = acct.parentId ? phase1Map.get(acct.parentId) : null;
      return formatApiAccount(acct, cachedIds, phase1);
    });

    return Response.json({
      accounts,
      page: result.page,
      pageSize: result.pageSize,
      hasMore: result.hasMore,
      totalAccounts: result.total,
      stats,
    });
  } catch (err) {
    console.error('[challenges/dashboard] Error:', err);
    return Response.json({ error: 'Failed to load passed challenge accounts' }, { status: 500 });
  }
}
