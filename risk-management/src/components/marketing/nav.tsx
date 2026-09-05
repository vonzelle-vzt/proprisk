import Link from 'next/link';
import { brand } from '@/config/brand';

/**
 * Marketing nav — see DESIGN.md "Marketing surface" section for why this
 * uses the larger marketing type scale instead of the 10-11px operator
 * density used everywhere else in the app.
 */
export function MarketingNav() {
  return (
    <header className="sticky top-0 z-10 border-b border-white/10 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/home" className="text-lg font-bold text-white">
          {brand.productName}
        </Link>
        <nav className="flex items-center gap-6 text-sm text-gray-300">
          <Link href="/pricing" className="hover:text-white transition-colors">
            Pricing
          </Link>
          <Link href="/login" className="hover:text-white transition-colors">
            Log in
          </Link>
          <Link
            href="/signup"
            className="rounded-xl border border-red-500/50 bg-red-600 px-4 py-2 font-medium text-white shadow-lg shadow-red-500/20 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500/50 focus:ring-offset-2 focus:ring-offset-background"
          >
            Start free
          </Link>
        </nav>
      </div>
    </header>
  );
}
