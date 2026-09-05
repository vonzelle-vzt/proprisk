'use client';

import { usePathname } from 'next/navigation';
import { Bell, User, LineChart, CandlestickChart } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { DEMO_MODE } from '@/lib/demo';
import { useProviderContext } from '@/components/layout/provider-context';

const pageTitle: Record<string, string> = {
  '/payouts': 'Pending Payouts Risk Control',
  '/deductions': 'Executed Deductions Summary',
  '/violations': 'Risk Violation Reports',
  '/connections': 'Platform Integrations',
  '/alerts': 'Live Risk Alerts',
};

const ASSET_SEGMENTS = [
  { id: 'forex', label: 'Forex', icon: LineChart },
  { id: 'futures', label: 'Futures', icon: CandlestickChart },
] as const;

export function Header() {
  const pathname = usePathname();
  const title = Object.entries(pageTitle).find(([path]) => pathname.startsWith(path))?.[1] || 'Dashboard';
  const { assetClass, setAssetClass } = useProviderContext();

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between border-b border-white/10 bg-[#0a0a0a]/80 backdrop-blur-xl px-8 py-4">
      <div className="flex items-center gap-4">
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        {DEMO_MODE && (
          <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-amber-400">
            Demo
          </span>
        )}
      </div>

      <div className="flex items-center gap-4">
        {/* Global Forex / Futures asset-class toggle — re-scopes every page */}
        <div className="inline-flex gap-0.5 rounded-lg border border-white/10 bg-white/5 p-0.5">
          {ASSET_SEGMENTS.map((seg) => {
            const Icon = seg.icon;
            const active = assetClass === seg.id;
            return (
              <button
                key={seg.id}
                onClick={() => setAssetClass(seg.id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-200',
                  active
                    ? 'border border-white/15 bg-white/10 text-white shadow-sm'
                    : 'border border-transparent text-gray-500 hover:text-gray-300'
                )}
                title={`Show ${seg.label} risk`}
              >
                <Icon className="h-3.5 w-3.5" />
                {seg.label}
              </button>
            );
          })}
        </div>

        <button className="relative p-2 rounded-xl text-gray-400 hover:bg-white/5 hover:text-white transition-colors">
          <Bell className="h-5 w-5" />
          <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-red-500" />
        </button>
        <div className="flex items-center gap-3 rounded-xl bg-white/5 border border-white/10 px-3 py-1.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-red-600/20">
            <User className="h-4 w-4 text-red-400" />
          </div>
          <div>
            <p className="text-xs font-medium text-gray-200">Risk Analyst</p>
            <p className="text-[10px] text-gray-500">Admin</p>
          </div>
        </div>
      </div>
    </header>
  );
}
