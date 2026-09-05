'use client';

import { useState, useEffect, useCallback } from 'react';

interface UseChallengeDeductionsParams {
  search?: string;
  violationType?: string;
  page?: number;
  perPage?: number;
}

export function useChallengeDeductions(params: UseChallengeDeductionsParams = {}) {
  const { search, violationType, page = 1, perPage = 100 } = params;
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        page: String(page),
        per_page: String(perPage),
      });
      if (search) query.set('search', search);
      if (violationType) query.set('violation_type', violationType);

      const res = await fetch(`/api/platform/deductions/challenges?${query}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      // If search returned no results, try on-demand fetch from the provider platform API
      if (search && json.total === 0 && !violationType) {
        setSearching(true);
        try {
          const searchRes = await fetch(`/api/platform/challenges/search?q=${encodeURIComponent(search)}`);
          if (searchRes.ok) {
            const searchJson = await searchRes.json();
            if (searchJson.data) {
              // Account was found and cached — re-fetch deductions
              const retryRes = await fetch(`/api/platform/deductions/challenges?${query}`);
              if (retryRes.ok) {
                const retryJson = await retryRes.json();
                setData(retryJson);
                return;
              }
            }
          }
        } finally {
          setSearching(false);
        }
      }

      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [search, violationType, page, perPage]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, searching, refetch: fetchData };
}
