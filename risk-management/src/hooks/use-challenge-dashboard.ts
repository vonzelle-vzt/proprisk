'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import type { CachedChallengeAccount } from '@/lib/challenges/cache';

export interface PassedChallengeAccount {
  accountId: number;
  login: number;
  userId: number;
  email: string;
  firstName: string;
  lastName: string;
  country: string;
  planName: string;
  type: number;
  typeLabel: string;
  phase: number;
  startingBalance: number;
  lastBalance: number;
  lastEquity: number;
  tradedDays: number;
  banNewsTrading: boolean;
  banHFT: boolean;
  banMTGL: boolean;
  parentId: number | null;
  childId: number | null;
  addedUTC: string;
  analysisStatus: 'cached' | 'not_analyzed';
  phase1: {
    accountId: number;
    login: number;
    planName: string;
    startingBalance: number;
    lastBalance: number;
    lastEquity: number;
    tradedDays: number;
    lastUpdatedUTC: string;
    analysisStatus: 'cached' | 'not_analyzed';
  } | null;
}

export interface AnalysisResult {
  phase2: CachedChallengeAccount | null;
  phase1: CachedChallengeAccount | null;
  source: 'cache' | 'live';
}

export interface GlobalStats {
  analyzedCount: number;
  withViolations: number;
  totalDeductions: number;
  violationBreakdown: { type: string; label: string; count: number; amount: number }[];
}

export function usePassedChallenges() {
  const [accounts, setAccounts] = useState<PassedChallengeAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [analysisResults, setAnalysisResults] = useState<Record<string, AnalysisResult>>({});
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [revalidatingId, setRevalidatingId] = useState<string | null>(null);
  const [totalAccounts, setTotalAccounts] = useState(0);
  const [globalStats, setGlobalStats] = useState<GlobalStats>({ analyzedCount: 0, withViolations: 0, totalDeductions: 0, violationBreakdown: [] });
  const [notPassed, setNotPassed] = useState(false);
  const [notPassedDetails, setNotPassedDetails] = useState<{ login: number; accountId: number; type: string; phase: number; status: number } | null>(null);
  const [notPassedAnalysis, setNotPassedAnalysis] = useState<CachedChallengeAccount | null>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const fetchAccounts = useCallback(async (pageNum: number, searchTerm: string) => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        page: String(pageNum),
        pageSize: '25',
      });
      if (searchTerm) query.set('search', searchTerm);

      const res = await fetch(`/api/platform/dashboard/challenges?${query}`, { cache: 'no-store' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setAccounts(json.accounts || []);
      setHasMore(json.hasMore || false);
      setTotalAccounts(json.totalAccounts || 0);
      if (json.stats) setGlobalStats(json.stats);
      setNotPassed(json.notPassed || false);
      setNotPassedDetails(json.notPassedDetails || null);
      setNotPassedAnalysis(json.notPassedAnalysis || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load passed challenges');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount and when page changes
  useEffect(() => {
    fetchAccounts(page, search);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search
  const handleSearch = useCallback((term: string) => {
    setSearch(term);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setPage(1);
      fetchAccounts(1, term);
    }, 400);
  }, [fetchAccounts]);

  // On-demand analysis when row is expanded
  const analyzeAccount = useCallback(async (account: PassedChallengeAccount) => {
    const id = account.accountId.toString();
    const isCached = account.analysisStatus === 'cached';
    // Only show spinner for fresh analyses, not for cached lookups
    if (!isCached) setAnalyzingId(id);
    try {
      const res = await fetch('/api/platform/challenges/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: id,
          type: account.type,
          parentId: account.parentId || undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result: AnalysisResult = await res.json();
      setAnalysisResults((prev) => ({ ...prev, [id]: result }));

      // Update the account's analysisStatus in the list
      setAccounts((prev) =>
        prev.map((a) =>
          a.accountId === account.accountId
            ? { ...a, analysisStatus: 'cached' as const }
            : a
        )
      );

      // Update global stats incrementally (only for fresh analyses)
      if (result.source === 'live') {
        const p2Ded = result.phase2?.total_deductions || 0;
        const p1Ded = result.phase1?.total_deductions || 0;
        setGlobalStats((prev) => ({
          ...prev,
          analyzedCount: prev.analyzedCount + 1,
          withViolations: prev.withViolations + (p2Ded + p1Ded > 0 ? 1 : 0),
          totalDeductions: prev.totalDeductions + p2Ded + p1Ded,
        }));
      }
    } catch (err) {
      console.error('Analysis failed:', err);
    } finally {
      if (!isCached) setAnalyzingId(null);
    }
  }, []);

  // Force re-analysis bypassing cache
  const revalidateAccount = useCallback(async (account: PassedChallengeAccount) => {
    const id = account.accountId.toString();
    setRevalidatingId(id);
    try {
      const res = await fetch('/api/platform/challenges/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: id,
          type: account.type,
          parentId: account.parentId || undefined,
          forceRevalidate: true,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result: AnalysisResult = await res.json();
      setAnalysisResults((prev) => ({ ...prev, [id]: result }));
    } catch (err) {
      console.error('Revalidation failed:', err);
    } finally {
      setRevalidatingId(null);
    }
  }, []);

  const toggleExpand = useCallback((account: PassedChallengeAccount) => {
    const id = account.accountId.toString();
    if (expandedId === id) {
      setExpandedId(null);
    } else {
      setExpandedId(id);
      // Trigger analysis if not already cached
      if (!analysisResults[id]) {
        analyzeAccount(account);
      }
    }
  }, [expandedId, analysisResults, analyzeAccount]);

  return {
    accounts,
    loading,
    error,
    page,
    hasMore,
    search,
    expandedId,
    analysisResults,
    analyzingId,
    totalAccounts,
    globalStats,
    notPassed,
    notPassedDetails,
    notPassedAnalysis,
    revalidatingId,
    setPage,
    handleSearch,
    toggleExpand,
    revalidateAccount,
    refresh: () => fetchAccounts(page, search),
  };
}
