'use client';

import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { cn } from '@/lib/utils/cn';
import { useSidebar } from './sidebar-context';
import { createClient } from '@/lib/supabase/client';
import Image from 'next/image';
import { brand } from '@/config/brand';
import {
  Activity,
  AlertTriangle,
  Bot,
  Clock,
  DollarSign,
  FileSearch,
  Mail,
  Settings,
  LogOut,
  Shield,
  Wallet,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Scale,
  Share2,
  Siren,
} from 'lucide-react';

const navItems = [
  { href: '/risk', label: 'Risk Dashboard', icon: Activity },
  { href: '/alerts', label: 'Live Alerts', icon: Siren },
  { href: '/rules', label: 'Rule Packs', icon: ListChecks },
  { href: '/payouts', label: 'Pending Payouts', icon: Wallet },
  { href: '/history', label: 'Payout History', icon: Clock },
  { href: '/deductions', label: 'Executed Deductions', icon: DollarSign },
  { href: '/violations', label: 'Violation Reports', icon: AlertTriangle },
  { href: '/network', label: 'Network', icon: Share2 },
  { href: '/enforcement', label: 'Enforcement', icon: Shield },
  { href: '/disputes', label: 'Disputes', icon: Scale },
  { href: '/reviewer', label: 'Reviewer Reports', icon: FileSearch },
  { href: '/email-log', label: 'Email Log', icon: Mail },
  { href: '/ai', label: 'AI Analytics', icon: Bot },
  { href: '/connections', label: 'Integrations', icon: Plug },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { collapsed, toggle } = useSidebar();

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  };

  return (
    <aside
      className={cn(
        'fixed left-0 top-0 z-40 h-screen border-r border-white/10 bg-black/80 backdrop-blur-xl transition-all duration-300',
        collapsed ? 'w-16' : 'w-64'
      )}
    >
      <div className="flex h-full flex-col">
        {/* Logo */}
        <div className={cn(
          'flex items-center border-b border-white/10 px-3 py-5',
          collapsed ? 'justify-center' : 'gap-3 px-6'
        )}>
          <Image src={brand.logoUrl} alt={brand.companyName} width={36} height={36} className="shrink-0 rounded-xl shadow-lg" />
          {!collapsed && (
            <div className="min-w-0">
              <h1 className="text-sm font-bold text-white tracking-wide">{brand.productName}</h1>
              <p className="text-[10px] text-gray-500 uppercase tracking-widest">{brand.companyName}</p>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 px-2 py-4">
          {!collapsed && (
            <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Dashboard
            </p>
          )}
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={collapsed ? item.label : undefined}
                className={cn(
                  'flex items-center rounded-xl text-sm font-medium transition-all duration-200',
                  collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-3 py-2.5',
                  isActive
                    ? 'bg-red-600/20 text-red-400 border border-red-500/30 shadow-lg shadow-red-500/10'
                    : 'text-gray-400 hover:bg-white/5 hover:text-gray-200 border border-transparent'
                )}
              >
                <item.icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-red-400' : 'text-gray-500')} />
                {!collapsed && item.label}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="border-t border-white/10 p-2">
          <button
            onClick={toggle}
            className={cn(
              'flex w-full items-center rounded-xl px-3 py-2.5 text-sm text-gray-500 hover:bg-white/5 hover:text-gray-300 transition-colors',
              collapsed ? 'justify-center px-0' : 'gap-3'
            )}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            {!collapsed && 'Collapse'}
          </button>
          <Link
            href="/settings"
            className={cn(
              'flex w-full items-center rounded-xl px-3 py-2.5 text-sm text-gray-500 hover:bg-white/5 hover:text-gray-300 transition-colors',
              collapsed ? 'justify-center px-0' : 'gap-3',
              pathname === '/settings' && 'bg-white/5 text-gray-300'
            )}
            title={collapsed ? 'Settings' : undefined}
          >
            <Settings className="h-4 w-4 shrink-0" />
            {!collapsed && 'Settings'}
          </Link>
          <button
            onClick={handleSignOut}
            className={cn(
              'flex w-full items-center rounded-xl px-3 py-2.5 text-sm text-gray-500 hover:bg-red-500/10 hover:text-red-400 transition-colors',
              collapsed ? 'justify-center px-0' : 'gap-3'
            )}
            title={collapsed ? 'Sign Out' : undefined}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {!collapsed && 'Sign Out'}
          </button>
        </div>
      </div>
    </aside>
  );
}
