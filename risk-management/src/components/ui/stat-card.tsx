import { cn } from '@/lib/utils/cn';
import { GlassCard } from './glass-card';
import { Info, LucideIcon } from 'lucide-react';

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: LucideIcon;
  trend?: { value: number; label: string };
  info?: string;
  onClick?: () => void;
  className?: string;
}

export function StatCard({ title, value, subtitle, icon: Icon, trend, info, onClick, className }: StatCardProps) {
  return (
    <GlassCard padding="sm" className={cn('flex flex-col gap-1', onClick && 'cursor-pointer hover:border-white/20 transition-colors', className)} onClick={onClick}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400 flex items-center gap-1">
          {title}
          {info && (
            <span className="relative group">
              <Info className="h-3 w-3 text-gray-600 hover:text-gray-400 cursor-help" />
              <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2.5 rounded-lg bg-[#1a1a1f] border border-white/15 shadow-xl text-[10px] text-gray-400 leading-relaxed opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto z-50 transition-opacity normal-case tracking-normal font-normal">
                {info}
              </span>
            </span>
          )}
        </span>
        {Icon && <Icon className="h-3.5 w-3.5 text-gray-500" />}
      </div>
      <div className="text-lg font-bold text-white leading-tight">{value}</div>
      {subtitle && <span className="text-[10px] text-gray-500 leading-tight">{subtitle}</span>}
      {trend && (
        <div className={cn(
          'flex items-center gap-1 text-[10px] font-medium',
          trend.value >= 0 ? 'text-red-400' : 'text-emerald-400'
        )}>
          <span>{trend.value >= 0 ? '+' : ''}{trend.value}%</span>
          <span className="text-gray-500">{trend.label}</span>
        </div>
      )}
    </GlassCard>
  );
}
