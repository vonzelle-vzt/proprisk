import { cn } from '@/lib/utils/cn';
import { Loader2 } from 'lucide-react';

type ButtonVariant = 'primary' | 'success' | 'warning' | 'secondary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: React.ReactNode;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: 'bg-red-600 hover:bg-red-700 text-white border-red-500/50 shadow-lg shadow-red-500/20 hover:shadow-red-500/40',
  success: 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-500/50 shadow-lg shadow-emerald-500/20 hover:shadow-emerald-500/40',
  warning: 'bg-orange-600 hover:bg-orange-700 text-white border-orange-500/50 shadow-lg shadow-orange-500/20 hover:shadow-orange-500/40',
  secondary: 'bg-white/10 hover:bg-white/20 text-gray-200 border-white/20 hover:border-white/30',
  danger: 'bg-red-900/50 hover:bg-red-900/70 text-red-300 border-red-500/30 hover:border-red-500/50',
  ghost: 'bg-transparent hover:bg-white/5 text-gray-400 hover:text-gray-200 border-transparent',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
};

export function Button({ variant = 'primary', size = 'md', loading = false, children, className, disabled, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl border font-medium transition-all duration-200',
        'focus:outline-none focus:ring-2 focus:ring-red-500/50 focus:ring-offset-2 focus:ring-offset-[#0a0a0a]',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variantStyles[variant],
        sizeStyles[size],
        className
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}
