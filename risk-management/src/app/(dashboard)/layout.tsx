'use client';

import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { SidebarProvider, useSidebar } from '@/components/layout/sidebar-context';
import { ProviderProvider } from '@/components/layout/provider-context';
import { GetHelpWidget } from '@/components/support/get-help-widget';

function DashboardContent({ children }: { children: React.ReactNode }) {
  const { collapsed } = useSidebar();

  return (
    <div className={`transition-all duration-300 ${collapsed ? 'ml-16' : 'ml-64'}`}>
      <Header />
      <main className="p-6">{children}</main>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <ProviderProvider>
        <div className="min-h-screen bg-[#0a0a0a]">
          <Sidebar />
          <DashboardContent>{children}</DashboardContent>
          {/* Mounted at the layout so a firm can raise a ticket from wherever
              the problem is, and the diagnostics attached to it describe the
              page they were actually on. */}
          <GetHelpWidget />
        </div>
      </ProviderProvider>
    </SidebarProvider>
  );
}
