'use client';

import { Calendar, X } from 'lucide-react';

interface DateRangeFilterProps {
  startDate: string;
  endDate: string;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
}

export function DateRangeFilter({ startDate, endDate, onStartChange, onEndChange }: DateRangeFilterProps) {
  const hasValue = startDate || endDate;

  return (
    <div className="flex items-center gap-2">
      <Calendar className="h-3.5 w-3.5 text-gray-500 shrink-0" />
      <input
        type="date"
        value={startDate}
        onChange={(e) => onStartChange(e.target.value)}
        className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-gray-300 focus:border-red-500/50 focus:outline-none"
      />
      <span className="text-gray-600 text-xs">to</span>
      <input
        type="date"
        value={endDate}
        onChange={(e) => onEndChange(e.target.value)}
        className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-gray-300 focus:border-red-500/50 focus:outline-none"
      />
      {hasValue && (
        <button
          onClick={() => { onStartChange(''); onEndChange(''); }}
          className="rounded-lg p-1 text-gray-500 hover:text-gray-300 hover:bg-white/5 transition-colors"
          title="Clear dates"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
