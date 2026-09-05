'use client';

import { cn } from '@/lib/utils/cn';

interface Tab {
  id: string;
  label: string;
  count?: number;
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onChange: (tabId: string) => void;
  className?: string;
}

export function Tabs({ tabs, activeTab, onChange, className }: TabsProps) {
  return (
    <div className={cn('flex gap-1 bg-white/5 rounded-xl p-1 border border-white/10', className)}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            'px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200',
            activeTab === tab.id
              ? 'bg-red-600/80 text-white shadow-lg shadow-red-500/20'
              : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
          )}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className={cn(
              'ml-2 px-1.5 py-0.5 rounded-full text-xs',
              activeTab === tab.id ? 'bg-white/20' : 'bg-white/10'
            )}>
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
