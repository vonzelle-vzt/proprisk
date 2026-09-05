import Link from 'next/link';
import { brand } from '@/config/brand';

export function MarketingFooter() {
  return (
    <footer className="border-t border-white/10 py-10 text-sm text-gray-500">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 sm:flex-row">
        <p>
          © {new Date().getFullYear()} {brand.companyName}. {brand.productName}.
        </p>
        <div className="flex gap-6">
          <Link href="/pricing" className="hover:text-gray-300 transition-colors">
            Pricing
          </Link>
          <Link href="/login" className="hover:text-gray-300 transition-colors">
            Log in
          </Link>
          <Link href="/signup" className="hover:text-gray-300 transition-colors">
            Sign up
          </Link>
        </div>
      </div>
    </footer>
  );
}
