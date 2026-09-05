import { MarketingNav } from '@/components/marketing/nav';
import { MarketingFooter } from '@/components/marketing/footer';

/**
 * Marketing surface layout — the public landing/pricing pages. Deliberately
 * NOT the operator-terminal density used everywhere else in this app; see
 * DESIGN.md's "Marketing surface" section for why.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <MarketingNav />
      <main>{children}</main>
      <MarketingFooter />
    </div>
  );
}
