'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { FraudInvestigation } from '@/types/fraud';

interface UseFraudInvestigationsParams {
  status?: string;
  fraud_type?: string;
  severity?: string;
}

export function useFraudInvestigations(filters?: UseFraudInvestigationsParams) {
  const [investigations, setInvestigations] = useState<FraudInvestigation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const fetchInvestigations = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (filters?.status) query.set('status', filters.status);
      if (filters?.fraud_type) query.set('fraud_type', filters.fraud_type);
      if (filters?.severity) query.set('severity', filters.severity);

      const res = await fetch(`/api/fraud-hunter/investigations?${query}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setInvestigations(json.investigations ?? json.data ?? json);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [filters?.status, filters?.fraud_type, filters?.severity]);

  const runScan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const res = await fetch('/api/fraud-hunter/scan', {
        method: 'POST',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`Scan failed: HTTP ${res.status}`);
      await fetchInvestigations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  }, [fetchInvestigations]);

  useEffect(() => {
    fetchInvestigations();

    const interval = setInterval(fetchInvestigations, 30_000);

    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, [fetchInvestigations]);

  return { investigations, loading, error, scanning, refetch: fetchInvestigations, runScan };
}
