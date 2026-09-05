'use client';

import { useEffect, useState } from 'react';

interface RiskDashboardResponse {
  active_profile: { id: string; name: string; status: string } | null;
  compliance_score: number;
  decision_summary: { pass: number; warn: number; block: number };
  recent_alerts: Array<{ id: string; severity: string; status: string; title: string; created_at: string }>;
  recent_violations: Array<{ id: string; severity: string; status: string; violation_type: string; created_at: string }>;
  lockout_active: boolean;
}

export function useRiskDashboard(accountId: string) {
  const [data, setData] = useState<RiskDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/risk/dashboard?account_id=${accountId}`, { cache: 'no-store' });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || 'Failed to load risk dashboard');
        }
        const payload = await response.json();
        if (active) setData(payload.data);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Unexpected error');
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    return () => {
      active = false;
    };
  }, [accountId]);

  return { data, loading, error };
}
