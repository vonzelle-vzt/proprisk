'use client';

import { cn } from '@/lib/utils/cn';

interface Segment {
  id: string;
  label: string;
  count?: number;
}

interface SegmentToggleProps {
  segments: Segment[];
  active: string;
  onChange: (segmentId: string) => void;
  className?: string;
}

export function SegmentToggle({ segments, active, onChange, className }: SegmentToggleProps) {
  return (
    <div className={cn('inline-flex gap-0.5 bg-white/5 rounded-lg p-0.5 border border-white/10', className)}>
      {segments.map((seg) => (
        <button
          key={seg.id}
          onClick={() => onChange(seg.id)}
          className={cn(
            'px-3.5 py-1.5 rounded-md text-xs font-medium transition-all duration-200 whitespace-nowrap',
            active === seg.id
              ? 'bg-white/10 text-white shadow-sm border border-white/15'
              : 'text-gray-500 hover:text-gray-300 border border-transparent'
          )}
        >
          {seg.label}
          {seg.count !== undefined && (
            <span className={cn(
              'ml-1.5 px-1.5 py-0.5 rounded-full text-[10px]',
              active === seg.id ? 'bg-white/15 text-white' : 'bg-white/5 text-gray-600'
            )}>
              {seg.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
