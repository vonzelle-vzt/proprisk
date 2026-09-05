'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { PayoutHistoryRecord, PayoutHistorySummary } from '@/types/history';
import { useAssetClass } from '@/components/layout/provider-context';

interface PaginatedResult {
  data: PayoutHistoryRecord[];
  meta: { page: number; per_page: number; total: number; total_pages: number };
}

interface HistoryParams {
  startDate?: string;
  endDate?: string;
  decision?: string;
  search?: string;
  page?: number;
  perPage?: number;
}

// Module-level flag — sync fires once per browser session
let syncFired = false;

export function usePayoutHistory(params: HistoryParams = {}) {
  const assetClass = useAssetClass();
  const [data, setData] = useState<PaginatedResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refetchRef = useRef<() => void>();

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (params.startDate) query.set('start_date', params.startDate);
      if (params.endDate) query.set('end_date', params.endDate);
      if (params.decision) query.set('decision', params.decision);
      if (params.search) query.set('search', params.search);
      if (params.page) query.set('page', String(params.page));
      if (params.perPage) query.set('per_page', String(params.perPage));
      query.set('assetClass', assetClass);

      query.set('_t', String(Date.now()));
      const res = await fetch(`/api/history?${query.toString()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch history');
    } finally {
      setLoading(false);
    }
  }, [params.startDate, params.endDate, params.decision, params.search, params.page, params.perPage, assetClass]);

  // Clear stale history on asset-class switch.
  useEffect(() => { setData(null); setLoading(true); }, [assetClass]);

  // Keep a stable ref to fetchHistory for the sync callback
  refetchRef.current = fetchHistory;

  // Sync externally-decided payouts from the provider platform, then refetch history if new records found.
  // Keeps calling sync while there are remaining payouts to process (batched to avoid timeout).
  useEffect(() => {
    if (syncFired) return;
    syncFired = true;

    let cancelled = false;

    async function runSync() {
      let retries = 0;
      const MAX_RETRIES = 3;
      let hasMore = true;

      while (hasMore && !cancelled && retries < 100) {
        try {
          const res = await fetch('/api/history/sync', { method: 'POST' });
          if (!res.ok) {
            retries++;
            if (retries >= MAX_RETRIES) break;
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }

          retries = 0; // reset on success
          const result = await res.json();

          if (result?.synced > 0) {
            refetchRef.current?.();
          }

          hasMore = (result?.remaining ?? 0) > 0;
          if (hasMore) await new Promise((r) => setTimeout(r, 1500));
        } catch {
          retries++;
          if (retries >= MAX_RETRIES) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    runSync();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  return { data, loading, error, refetch: fetchHistory };
}

export function usePayoutHistorySummary(startDate?: string, endDate?: string) {
  const assetClass = useAssetClass();
  const [data, setData] = useState<PayoutHistorySummary | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (startDate) query.set('start_date', startDate);
      if (endDate) query.set('end_date', endDate);
      query.set('assetClass', assetClass);

      query.set('_t', String(Date.now()));
      const res = await fetch(`/api/history/summary?${query.toString()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json.data);
    } catch {
      // noop
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, assetClass]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  return { data, loading, refetch: fetchSummary };
}
