'use client';

import { useEffect, useMemo, useState } from 'react';
import { GlassCard } from '@/components/ui/glass-card';
import { StatCard } from '@/components/ui/stat-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Plug, RefreshCw, ExternalLink, CheckCircle2, CircleDashed, Lock, LineChart, CandlestickChart } from 'lucide-react';

interface ProviderHealth {
  id: string;
  label: string;
  assetClass: 'forex' | 'futures';
  kind: 'native-violations' | 'raw-data';
  manager: boolean;
  transport: string;
  docsUrl: string;
  status: 'live' | 'demo' | 'not_configured';
  accountCount: number;
  canEnforce: boolean;
  lastSync: string | null;
}

const STATUS_BADGE: Record<string, { variant: 'green' | 'yellow' | 'silver'; label: string }> = {
  live: { variant: 'green', label: 'Live' },
  demo: { variant: 'yellow', label: 'Demo' },
  not_configured: { variant: 'silver', label: 'Not Configured' },
};

export default function ConnectionsPage() {
  const [providers, setProviders] = useState<ProviderHealth[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchProviders = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/providers', { cache: 'no-store' });
      const json = await res.json();
      setProviders(json.providers ?? []);
    } catch {
      setProviders([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProviders();
  }, []);

  const stats = useMemo(() => {
    const connected = providers.filter((p) => p.status !== 'not_configured');
    return {
      total: providers.length,
      connected: connected.length,
      forex: providers.filter((p) => p.assetClass === 'forex').length,
      futures: providers.filter((p) => p.assetClass === 'futures').length,
      accounts: connected.reduce((s, p) => s + p.accountCount, 0),
    };
  }, [providers]);

  const forex = providers.filter((p) => p.assetClass === 'forex');
  const futures = providers.filter((p) => p.assetClass === 'futures');

  const renderCard = (p: ProviderHealth) => {
    const badge = STATUS_BADGE[p.status];
    return (
      <GlassCard key={p.id} padding="sm">
        <div className="flex items-start justify-between mb-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-white truncate">{p.label}</h3>
              <Badge variant={badge.variant} className="!text-[9px]">{badge.label}</Badge>
            </div>
            <p className="text-[10px] text-gray-500 mt-0.5">{p.transport}</p>
          </div>
          {p.status === 'live' ? (
            <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />
          ) : p.status === 'demo' ? (
            <CircleDashed className="h-4 w-4 text-amber-400 shrink-0" />
          ) : (
            <Lock className="h-4 w-4 text-gray-600 shrink-0" />
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 text-[10px] mb-2">
          <div>
            <span className="text-gray-600 block">Accounts</span>
            <span className="text-gray-200 font-medium">{p.accountCount.toLocaleString()}</span>
          </div>
          <div>
            <span className="text-gray-600 block">Access</span>
            <span className="text-gray-200 font-medium">{p.manager ? 'Firm-wide' : 'Per-trader'}</span>
          </div>
          <div>
            <span className="text-gray-600 block">Risk model</span>
            <span className="text-gray-200 font-medium">{p.kind === 'native-violations' ? 'Native' : 'Computed'}</span>
          </div>
          <div>
            <span className="text-gray-600 block">Enforcement</span>
            <span className="text-gray-200 font-medium">{p.canEnforce ? 'Supported' : '—'}</span>
          </div>
        </div>

        <a
          href={p.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300"
        >
          <ExternalLink className="h-3 w-3" /> API docs
        </a>
      </GlassCard>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Plug className="h-5 w-5 text-red-400" /> Platform Integrations
          </h1>
          <p className="text-xs text-gray-500">
            One risk desk across every major Forex and Futures trading platform — connect a platform to go live.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={fetchProviders}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard title="Platforms Supported" value={stats.total} icon={Plug} />
        <StatCard title="Connected" value={stats.connected} icon={CheckCircle2} subtitle={`${stats.forex} forex · ${stats.futures} futures`} />
        <StatCard title="Accounts Monitored" value={stats.accounts.toLocaleString()} icon={LineChart} />
        <StatCard title="Asset Classes" value={2} icon={CandlestickChart} subtitle="Forex + Futures on one dashboard" />
      </div>

      <div>
        <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          <LineChart className="h-3 w-3" /> Forex / CFD Platforms
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">{forex.map(renderCard)}</div>
      </div>

      <div>
        <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          <CandlestickChart className="h-3 w-3" /> Futures Platforms
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">{futures.map(renderCard)}</div>
      </div>
    </div>
  );
}
