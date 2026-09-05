'use client';

import { useEffect, useState } from 'react';
import { LineChart, CandlestickChart, Layers, AlertTriangle, Wallet } from 'lucide-react';
import { formatCurrency } from '@/lib/utils/format';

interface AssetExposure {
  accounts: number;
  openExposure: number;
  payoutsPending: number;
  accountsInBreach: number;
  totalDeductions: number;
}

interface Exposure {
  byAssetClass: { forex: AssetExposure; futures: AssetExposure };
  combined: AssetExposure;
}

/**
 * Firm-wide exposure across BOTH asset classes at once — the "Forex + Futures
 * on one dashboard" headline. Independent of the Forex/Futures toggle.
 */
export function FirmExposureBand() {
  const [data, setData] = useState<Exposure | null>(null);

  useEffect(() => {
    fetch('/api/exposure', { cache: 'no-store' })
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null));
  }, []);

  if (!data) return null;
  const { combined, byAssetClass } = data;

  const Metric = ({ icon: Icon, label, value, accent }: { icon: any; label: string; value: string; accent?: string }) => (
    <div className="flex items-center gap-2.5">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/5">
        <Icon className={`h-4 w-4 ${accent || 'text-gray-400'}`} />
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-wider text-gray-500">{label}</p>
        <p className="text-sm font-bold text-white">{value}</p>
      </div>
    </div>
  );

  return (
    <div className="rounded-xl border border-white/10 bg-gradient-to-r from-white/[0.04] to-transparent px-5 py-3.5">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          <Layers className="h-3 w-3" /> Firm-Wide Exposure · Forex + Futures
        </span>
        <span className="flex items-center gap-3 text-[10px] text-gray-500">
          <span className="flex items-center gap-1"><LineChart className="h-3 w-3 text-sky-400" /> {byAssetClass.forex.accounts} forex</span>
          <span className="flex items-center gap-1"><CandlestickChart className="h-3 w-3 text-amber-400" /> {byAssetClass.futures.accounts} futures</span>
        </span>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Metric icon={Layers} label="Total Accounts" value={String(combined.accounts)} accent="text-sky-400" />
        <Metric icon={Wallet} label="Open Exposure" value={formatCurrency(combined.openExposure)} accent="text-green-400" />
        <Metric icon={AlertTriangle} label="Accounts In Breach" value={String(combined.accountsInBreach)} accent="text-red-400" />
        <Metric icon={Wallet} label="Payouts Pending" value={formatCurrency(combined.payoutsPending)} accent="text-amber-400" />
      </div>
    </div>
  );
}
