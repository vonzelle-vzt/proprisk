import { cn } from '@/lib/utils/cn';

type BadgeVariant = 'default' | 'red' | 'green' | 'yellow' | 'blue' | 'purple' | 'silver';

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  default: 'bg-white/10 text-gray-300 border-white/20',
  red: 'bg-red-500/20 text-red-400 border-red-500/30',
  green: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  yellow: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  blue: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  purple: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  silver: 'bg-gray-400/20 text-gray-300 border-gray-400/30',
};

export function Badge({ children, variant = 'default', className }: BadgeProps) {
  return (
    <span className={cn(
      'inline-flex items-center px-1.5 py-px rounded text-[9px] font-medium border leading-none whitespace-nowrap',
      variantStyles[variant],
      className
    )}>
      {children}
    </span>
  );
}
