'use client';

import { cn } from '@/lib/utils/cn';

interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  hover?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  glow?: 'none' | 'red' | 'silver';
}

const paddingMap = {
  none: '',
  sm: 'p-3',
  md: 'p-5',
  lg: 'p-8',
};

export function GlassCard({ children, hover = false, padding = 'md', glow = 'none', className, ...props }: GlassCardProps) {
  return (
    <div
      className={cn(
        'bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl',
        paddingMap[padding],
        hover && 'hover:bg-white/10 hover:border-red-500/30 transition-all duration-300 cursor-pointer',
        glow === 'red' && 'border-red-500/50 shadow-red-500/10',
        glow === 'silver' && 'border-gray-400/50 shadow-gray-400/10',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
