'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { PayoutRecord } from '@/types/payouts';
import { useAssetClass } from '@/components/layout/provider-context';

interface UsePayoutsParams {
  startDate?: string;
  endDate?: string;
  status?: string;
  search?: string;
  page?: number;
  perPage?: number;
  pollInterval?: number; // ms — auto-refresh interval (default 30s)
}

interface PaginatedResult {
  data: PayoutRecord[];
  meta: { page: number; per_page: number; total: number; total_pages: number };
}

export function usePayouts(params: UsePayoutsParams = {}) {
  const assetClass = useAssetClass();
  const [data, setData] = useState<PaginatedResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchPayouts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (params.startDate) query.set('start_date', params.startDate);
      if (params.endDate) query.set('end_date', params.endDate);
      if (params.status) query.set('status', params.status);
      if (params.search) query.set('search', params.search);
      if (params.page) query.set('page', String(params.page));
      if (params.perPage) query.set('per_page', String(params.perPage));
      query.set('assetClass', assetClass);
      query.set('_t', String(Date.now()));

      const res = await fetch(`/api/payouts?${query.toString()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch payouts');
    } finally {
      setLoading(false);
    }
  }, [params.startDate, params.endDate, params.status, params.search, params.page, params.perPage, assetClass]);

  // Clear stale data on asset-class switch so the table shows a loading state.
  useEffect(() => { setData(null); setLoading(true); }, [assetClass]);

  useEffect(() => { fetchPayouts(); }, [fetchPayouts]);

  // Auto-refresh polling for real-time sync with the provider platform
  const pollMs = params.pollInterval ?? 0;
  useEffect(() => {
    if (pollMs <= 0) return;
    intervalRef.current = setInterval(() => { fetchPayouts(); }, pollMs);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchPayouts, pollMs]);

  return { data, loading, error, refetch: fetchPayouts };
}
