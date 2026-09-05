import type { Metadata } from 'next';
import { MarketingPricingTable } from '@/components/marketing/pricing-table';
import { brand } from '@/config/brand';

export const metadata: Metadata = {
  title: `Pricing — ${brand.productName}`,
  description: 'Published pricing, tiered by funded accounts monitored. No sales call required.',
};

export default function PricingPage() {
  return (
    <div className="pt-8">
      <MarketingPricingTable />
    </div>
  );
}
