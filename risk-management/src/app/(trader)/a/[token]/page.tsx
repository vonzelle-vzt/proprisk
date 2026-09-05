import { notFound } from 'next/navigation';
import { brand } from '@/config/brand';
import { DEMO_MODE } from '@/lib/demo';
import { loadTraderView } from '@/lib/trader/data';
import { DEMO_TRADER_TOKEN, demoVerifiedAccess } from '@/lib/trader/demo';
import { verifyTraderToken } from '@/lib/trader/tokens';
import { DrawdownFloorCard } from '@/components/trader/drawdown-floor-card';
import { HeadroomCard } from '@/components/trader/headroom-card';
import { RecentTrades } from '@/components/trader/recent-trades';
import { ViolationReports } from '@/components/trader/violation-reports';

export const dynamic = 'force-dynamic';

/**
 * The trader-facing view (docs/HOW-IT-WORKS.md §6.1) — a read-only page for
 * the person whose account this is, not for the firm. No navigation into the
 * rest of the app, no other account reachable: this page's only input is the
 * token in its own URL, which server-side is the whole authentication check.
 *
 * Rendered directly from `loadTraderView`/`verifyTraderToken` rather than
 * fetching the sibling API route over HTTP — same data, one fewer hop, and
 * this route group is exempt from middleware's session check the same way
 * the API route is (see middleware.ts's public-page allowlist), so there is
 * no session to thread through an internal fetch anyway.
 */
export default async function TraderAccountPage({ params }: { params: { token: string } }) {
  // DEMO_MODE has no real tokens and no service-role client for
  // `verifyTraderToken` to reach (see src/lib/supabase/admin.ts) — only the
  // fixed demo token resolves to anything, and it never touches Supabase.
  const verified = DEMO_MODE
    ? params.token === DEMO_TRADER_TOKEN
      ? demoVerifiedAccess()
      : null
    : await verifyTraderToken(params.token);
  if (!verified) notFound();

  const view = await loadTraderView(verified.tenantId, verified.accountId);
  if (!view) notFound();

  const drawdownItem = view.headroom.items.find((item) => item.ruleId === 'drawdown');
  const otherItems = view.headroom.items.filter((item) => item.ruleId !== 'drawdown');

  return (
    <main className="min-h-screen bg-[#0a0a0a] px-4 py-8 sm:px-6 md:py-12">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <header>
          <p className="text-sm text-gray-500">{brand.productName}</p>
          <h1 className="mt-1 text-2xl font-bold text-white">
            Account {view.account.login}
          </h1>
          <p className="mt-1 text-base text-gray-400">
            Balance ${view.account.currentBalance.toLocaleString()} &middot; Equity $
            {view.account.currentEquity.toLocaleString()}
          </p>
        </header>

        {drawdownItem && <DrawdownFloorCard item={drawdownItem} />}

        {otherItems.length > 0 && (
          <section className="flex flex-col gap-4">
            {otherItems.map((item) => (
              <HeadroomCard key={item.ruleId} item={item} />
            ))}
          </section>
        )}

        <ViolationReports token={params.token} violations={view.violations} />

        <RecentTrades trades={view.recentClosedTrades} />

        <p className="pb-4 text-center text-sm text-gray-600">
          This page is read-only and specific to your account. If you did not
          request this link, you can ignore it.
        </p>
      </div>
    </main>
  );
}
