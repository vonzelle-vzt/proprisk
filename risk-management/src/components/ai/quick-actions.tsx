'use client';

import { cn } from '@/lib/utils/cn';
import {
  FileText,
  AlertTriangle,
  Shield,
  Wallet,
  TrendingUp,
  HelpCircle,
} from 'lucide-react';

interface QuickActionsProps {
  onSelect: (message: string) => void;
  disabled?: boolean;
}

const actions = [
  { label: 'General Report', message: 'general report', icon: FileText },
  { label: 'Pending Payouts', message: 'pending payouts', icon: Wallet },
  { label: 'High Risk Accounts', message: 'high risk accounts', icon: TrendingUp },
  { label: 'Violation Summary', message: 'violations summary', icon: AlertTriangle },
  { label: 'Security Check', message: 'security check', icon: Shield },
  { label: 'Help', message: 'help', icon: HelpCircle },
];

export function QuickActions({ onSelect, disabled }: QuickActionsProps) {
  return (
    <div className="flex flex-wrap gap-2 justify-center">
      {actions.map((action) => (
        <button
          key={action.label}
          onClick={() => onSelect(action.message)}
          disabled={disabled}
          className={cn(
            'flex items-center gap-2 rounded-xl px-3 py-2',
            'bg-white/5 border border-white/10',
            'text-xs font-medium text-gray-400',
            'hover:bg-red-600/20 hover:text-red-400 hover:border-red-500/30',
            'disabled:opacity-30 disabled:cursor-not-allowed',
            'transition-all duration-200'
          )}
        >
          <action.icon className="h-3.5 w-3.5" />
          {action.label}
        </button>
      ))}
    </div>
  );
}
