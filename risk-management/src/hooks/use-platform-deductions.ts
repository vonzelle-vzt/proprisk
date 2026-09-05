'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAssetClass } from '@/components/layout/provider-context';

interface UsePlatformDeductionsParams {
  search?: string;
  violationType?: string;
  page?: number;
  perPage?: number;
}

export function usePlatformDeductions(params: UsePlatformDeductionsParams = {}) {
  const { search, violationType, page = 1, perPage = 100 } = params;
  const assetClass = useAssetClass();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        page: String(page),
        per_page: String(perPage),
        assetClass,
      });
      if (search) query.set('search', search);
      if (violationType) query.set('violation_type', violationType);

      const res = await fetch(`/api/platform/deductions?${query}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [search, violationType, page, perPage, assetClass]);

  useEffect(() => { setData(null); setLoading(true); }, [assetClass]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

export function usePlatformDeductionsSummary() {
  const assetClass = useAssetClass();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/platform/deductions/summary?assetClass=${assetClass}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [assetClass]);

  useEffect(() => { setData(null); setLoading(true); }, [assetClass]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}
