'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAssetClass } from '@/components/layout/provider-context';

export interface DashboardAccount {
  accountId: string;
  login: string;
  email: string;
  firstName: string;
  lastName: string;
  country: string;
  kycStatus: string;
  isBlackListed: boolean;
  plan: string;
  startingBalance: number;
  balance: number;
  totalPnL: number;
  payoutAmount: number;
  payoutRequestAmount: number;
  payoutClientAmount: number;
  profitSharePercentage: number | null;
  payoutStatus: string;
  payoutRequested: string;
  totalDeductions: number;
  violationCount: number;
  violationTypes: string[];
  violationLabels: string[];
  deductionBreakdown: Record<string, number>;
  severity: 'low' | 'medium' | 'high' | 'critical';
  banNewsTrading: boolean;
  banHFT: boolean;
  banMTGL: boolean;
  tradedDays: number;
  numApprovedPayouts: number;
  approvedPayouts: number;
  consistencyAtRequest: number | null;
  consistencyRequired: number | null;
  closedPnL: number | null;
  accountMetrics: Record<string, any>;
  // Multi-provider / multi-asset fields (present in demo + once providers wired)
  provider?: string;
  providerLabel?: string;
  sizeUnit?: 'lots' | 'contracts';
  canTrade?: boolean;
  maxDailyLossPct?: number;
  maxTrailingDrawdownPct?: number;
  maxPositionSize?: number;
}

export interface DashboardData {
  summary: {
    totalPendingPayouts: number;
    totalPayoutAmount: number;
    totalDeductions: number;
    accountsWithViolations: number;
    blacklistedAccounts: number;
    avgPayoutAmount: number;
    avgDeductionPerViolatedAccount: number;
  };
  violationTypeBreakdown: Array<{ type: string; label: string; count: number; amount: number }>;
  severityDistribution: { critical: number; high: number; medium: number; low: number };
  planDistribution: Array<{ plan: string; count: number; totalPayout: number }>;
  countryDistribution: Array<{ country: string; count: number }>;
  topFlaggedAccounts: DashboardAccount[];
  topPayouts: DashboardAccount[];
  allAccounts: DashboardAccount[];
}

export function usePlatformDashboard() {
  const assetClass = useAssetClass();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/platform/dashboard?assetClass=${assetClass}`, { cache: 'no-store' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, [assetClass]);

  // Clear stale data the instant the asset class changes so the page shows its
  // loading state immediately instead of lingering on the previous data.
  useEffect(() => { setData(null); setLoading(true); }, [assetClass]);
  useEffect(() => { fetchData(); }, [fetchData]);

  return { data, loading, error, refresh: fetchData };
}
