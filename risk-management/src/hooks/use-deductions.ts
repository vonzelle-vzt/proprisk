'use client';

import { useState, useEffect, useCallback } from 'react';

interface DeductionsParams {
  startDate: string;
  endDate: string;
  page: number;
  perPage: number;
}

export function useDeductions(params: DeductionsParams) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const searchParams = new URLSearchParams({
        start_date: params.startDate,
        end_date: params.endDate,
        page: params.page.toString(),
        per_page: params.perPage.toString(),
      });
      const res = await fetch(`/api/deductions?${searchParams}`);
      if (!res.ok) throw new Error('Failed to fetch deductions');
      setData(await res.json());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [params.startDate, params.endDate, params.page, params.perPage]);

  useEffect(() => { fetchData(); }, [fetchData]);

  return { data, loading, refetch: fetchData };
}
