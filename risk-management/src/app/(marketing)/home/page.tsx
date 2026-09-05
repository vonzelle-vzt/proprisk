import type { Metadata } from 'next';
import { MarketingHero } from '@/components/marketing/hero';
import { MarketingFeatureGrid } from '@/components/marketing/feature-grid';
import { MarketingPricingTable } from '@/components/marketing/pricing-table';
import { brand } from '@/config/brand';

export const metadata: Metadata = {
  title: `${brand.productName} — Risk management for prop-trading firms`,
  description:
    'Connect your own trading platform, configure rules from Apex/TopStep/FTMO-style presets, prove correctness in shadow mode, and publish your prices. No sales call required.',
};

// Route lives at /home rather than the app root ('/'): src/app/page.tsx
// already owns '/' (it redirects into the authenticated dashboard) and is
// outside this feature's FILES_IN_SCOPE, so colliding with it there isn't
// this change's call to make — see the build report for the follow-up this
// leaves open.
export default function MarketingHomePage() {
  return (
    <>
      <MarketingHero />
      <MarketingFeatureGrid />
      <MarketingPricingTable />
    </>
  );
}
