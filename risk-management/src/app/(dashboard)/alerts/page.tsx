'use client';

import { useEffect, useState, useCallback } from 'react';
import { GlassCard } from '@/components/ui/glass-card';
import { StatCard } from '@/components/ui/stat-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Siren, RefreshCw, AlertTriangle, ShieldAlert, BellRing } from 'lucide-react';
import { useAssetClass } from '@/components/layout/provider-context';
import { formatDateTime } from '@/lib/utils/format';

interface Alert {
  id: string;
  accountId: string;
  login: string;
  provider: string;
  providerLabel: string;
  assetClass: 'forex' | 'futures';
  type: string;
  label: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  detectedAt: string;
  status: 'active' | 'acknowledged';
}

const SEV_BADGE: Record<string, 'red' | 'yellow' | 'blue' | 'silver'> = {
  critical: 'red',
  high: 'yellow',
  medium: 'blue',
  low: 'silver',
};

export default function AlertsPage() {
  const assetClass = useAssetClass();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [acked, setAcked] = useState<Set<string>>(new Set());

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/alerts?assetClass=${assetClass}`, { cache: 'no-store' });
      const json = await res.json();
      setAlerts(json.data ?? []);
    } catch {
      setAlerts([]);
    } finally {
      setLoading(false);
    }
  }, [assetClass]);

  useEffect(() => { setAlerts([]); setLoading(true); setAcked(new Set()); }, [assetClass]);

  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 30000);
    return () => clearInterval(interval);
  }, [fetchAlerts]);

  const visible = alerts.map((a) => ({ ...a, status: acked.has(a.id) ? 'acknowledged' : a.status } as Alert));
  const active = visible.filter((a) => a.status === 'active');
  const critical = active.filter((a) => a.severity === 'critical');

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Siren className="h-5 w-5 text-red-400" /> Live Risk Alerts
          </h1>
          <p className="text-xs text-gray-500">
            Real-time breach feed for {assetClass === 'futures' ? 'Futures' : 'Forex'} — switch asset class in the header.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={fetchAlerts}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatCard title="Active Alerts" value={active.length} icon={BellRing} />
        <StatCard title="Critical Breaches" value={critical.length} icon={ShieldAlert} />
        <StatCard title="Total (24h)" value={visible.length} icon={AlertTriangle} />
      </div>

      <GlassCard padding="none">
        {loading && alerts.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-gray-500">
            <RefreshCw className="h-5 w-5 animate-spin mr-2" /> Loading alerts...
          </div>
        ) : visible.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <ShieldAlert className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No active alerts. All accounts within risk limits.</p>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {visible.map((a) => (
              <div
                key={a.id}
                className={`flex items-center gap-4 px-4 py-3 ${a.status === 'acknowledged' ? 'opacity-40' : ''}`}
              >
                <div className={`h-2 w-2 rounded-full shrink-0 ${a.severity === 'critical' ? 'bg-red-500 animate-pulse' : a.severity === 'high' ? 'bg-orange-500' : 'bg-blue-500'}`} />
                <Badge variant={SEV_BADGE[a.severity]} className="!text-[9px] shrink-0">{a.severity}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-gray-200 truncate">{a.message}</p>
                  <p className="text-[10px] text-gray-500">
                    {a.providerLabel} · Account {a.login} · {formatDateTime(a.detectedAt)}
                  </p>
                </div>
                <Badge variant="silver" className="!text-[9px] shrink-0">{a.label}</Badge>
                {a.status === 'active' ? (
                  <button
                    onClick={() => setAcked((prev) => new Set(prev).add(a.id))}
                    className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] text-gray-300 hover:bg-white/10"
                  >
                    Acknowledge
                  </button>
                ) : (
                  <span className="shrink-0 text-[10px] text-gray-600">Acknowledged</span>
                )}
              </div>
            ))}
          </div>
        )}
      </GlassCard>
    </div>
  );
}
