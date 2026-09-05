'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { ChevronDown } from 'lucide-react';

interface CollapsibleProps {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Collapsible({ title, count, defaultOpen = false, children, className }: CollapsibleProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={cn('border border-white/10 rounded-2xl overflow-hidden', className)}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-5 py-4 bg-white/5 hover:bg-white/10 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-white">{title}</span>
          {count !== undefined && (
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/20 text-red-400 border border-red-500/30">
              {count}
            </span>
          )}
        </div>
        <ChevronDown className={cn(
          'h-4 w-4 text-gray-400 transition-transform duration-200',
          isOpen && 'rotate-180'
        )} />
      </button>
      {isOpen && (
        <div className="px-3 py-3 bg-white/[0.02]">
          {children}
        </div>
      )}
    </div>
  );
}
