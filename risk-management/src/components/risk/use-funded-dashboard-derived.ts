import { useMemo } from 'react';
import type { DashboardData } from '@/hooks/use-platform-dashboard';

/**
 * Derives date-filtered accounts + all the Overview-tab aggregates
 * (severity distribution, violation breakdown, plan/country distribution,
 * summary stats) from the raw platform dashboard payload. Pulled out of
 * risk/page.tsx so the page stays a thin composition of sections.
 */
export function useFundedDashboardDerived(data: DashboardData | null, startDate: string, endDate: string) {
  const filteredFlagged = useMemo(() => {
    if (!data) return [];
    let items = data.topFlaggedAccounts;
    if (startDate) {
      const start = new Date(startDate);
      items = items.filter((a) => !a.payoutRequested || new Date(a.payoutRequested) >= start);
    }
    if (endDate) {
      const end = new Date(endDate + 'T23:59:59');
      items = items.filter((a) => !a.payoutRequested || new Date(a.payoutRequested) <= end);
    }
    return items;
  }, [data, startDate, endDate]);

  const filteredAll = useMemo(() => {
    if (!data) return [];
    let items = data.allAccounts;
    if (startDate) {
      const start = new Date(startDate);
      items = items.filter((a) => !a.payoutRequested || new Date(a.payoutRequested) >= start);
    }
    if (endDate) {
      const end = new Date(endDate + 'T23:59:59');
      items = items.filter((a) => !a.payoutRequested || new Date(a.payoutRequested) <= end);
    }
    return items;
  }, [data, startDate, endDate]);

  // Derive stats from filtered data so they respond to date changes
  const filteredStats = useMemo(() => {
    const accounts = filteredAll;
    const flagged = accounts.filter(a => a.totalDeductions > 0 || a.violationLabels.length > 0);
    const totalPayoutAmount = accounts.reduce((s, a) => s + a.payoutAmount, 0);
    const totalDeductions = accounts.reduce((s, a) => s + a.totalDeductions, 0);
    return {
      totalPendingPayouts: accounts.length,
      totalPayoutAmount,
      totalDeductions,
      accountsWithViolations: flagged.length,
      avgPayoutAmount: accounts.length > 0 ? totalPayoutAmount / accounts.length : 0,
      avgDeductionPerViolatedAccount: flagged.length > 0 ? totalDeductions / flagged.length : 0,
      blacklistedAccounts: accounts.filter(a => a.isBlackListed).length,
    };
  }, [filteredAll]);

  // Derive severity distribution from filtered accounts
  const filteredSeverity = useMemo(() => {
    const dist = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const a of filteredFlagged) {
      if (a.severity in dist) dist[a.severity as keyof typeof dist]++;
    }
    return dist;
  }, [filteredFlagged]);

  // Derive violation type breakdown from filtered accounts
  const filteredViolationBreakdown = useMemo(() => {
    const typeMap = new Map<string, { label: string; count: number; amount: number }>();
    for (const a of filteredAll) {
      for (const [type, amount] of Object.entries(a.deductionBreakdown)) {
        if (amount <= 0) continue;
        if (type === 'profit_cap' || type === '2_percent_cap') continue;
        const label = a.violationLabels[a.violationTypes.indexOf(type)] || type;
        const existing = typeMap.get(type);
        if (existing) {
          existing.count++;
          existing.amount += amount;
        } else {
          typeMap.set(type, { label, count: 1, amount });
        }
      }
    }
    return Array.from(typeMap.entries())
      .map(([type, d]) => ({ type, ...d }))
      .sort((a, b) => b.amount - a.amount);
  }, [filteredAll]);

  // Derive plan distribution from filtered accounts
  const filteredPlanDist = useMemo(() => {
    const planMap = new Map<string, { count: number; totalPayout: number }>();
    for (const a of filteredAll) {
      const plan = a.plan || 'Unknown';
      const existing = planMap.get(plan);
      if (existing) {
        existing.count++;
        existing.totalPayout += a.payoutAmount;
      } else {
        planMap.set(plan, { count: 1, totalPayout: a.payoutAmount });
      }
    }
    return Array.from(planMap.entries())
      .map(([plan, d]) => ({ plan, ...d }))
      .sort((a, b) => b.totalPayout - a.totalPayout);
  }, [filteredAll]);

  // Derive country distribution from filtered accounts
  const filteredCountryDist = useMemo(() => {
    const countryMap = new Map<string, number>();
    for (const a of filteredAll) {
      const country = a.country || 'Unknown';
      countryMap.set(country, (countryMap.get(country) || 0) + 1);
    }
    return Array.from(countryMap.entries())
      .map(([country, count]) => ({ country, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [filteredAll]);

  return {
    filteredFlagged,
    filteredAll,
    filteredStats,
    filteredSeverity,
    filteredViolationBreakdown,
    filteredPlanDist,
    filteredCountryDist,
  };
}
