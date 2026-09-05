'use client';

import { useState, useEffect, useCallback } from 'react';

interface DeductionsSummaryData {
  time_series: { date: string; count: number; total_amount: number }[];
  breakdowns: {
    by_violation_type: { type: string; count: number; total_amount: number }[];
    by_account_size: { size: number; count: number; total_amount: number }[];
    by_challenge_type: { type: string; count: number; total_amount: number }[];
  };
  totals: { count: number; total_amount: number };
}

export function useDeductionsSummary(startDate: string, endDate: string) {
  const [data, setData] = useState<DeductionsSummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/deductions/summary?start_date=${startDate}&end_date=${endDate}`);
      if (!res.ok) throw new Error('Failed to fetch deductions summary');
      const json = await res.json();
      setData(json);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => { fetchData(); }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}
