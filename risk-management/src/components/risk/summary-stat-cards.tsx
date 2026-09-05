import { Wallet, TrendingDown, AlertTriangle, DollarSign, Activity, Ban } from 'lucide-react';
import { StatCard } from '@/components/ui/stat-card';
import { formatCurrency } from '@/lib/utils/format';

export interface RiskSummaryStats {
  totalPendingPayouts: number;
  totalPayoutAmount: number;
  totalDeductions: number;
  accountsWithViolations: number;
  avgPayoutAmount: number;
  avgDeductionPerViolatedAccount: number;
  blacklistedAccounts: number;
}

/** Top-of-page stat card grid on the funded-payouts risk dashboard. */
export function SummaryStatCards({ stats }: { stats: RiskSummaryStats }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      <StatCard
        title="Pending Payouts"
        value={stats.totalPendingPayouts}
        icon={Wallet}
        subtitle={`${formatCurrency(stats.totalPayoutAmount)} total`}
      />
      <StatCard
        title="Total Deductions"
        value={formatCurrency(stats.totalDeductions)}
        icon={TrendingDown}
        subtitle={`${stats.accountsWithViolations} accounts flagged`}
      />
      <StatCard
        title="Flagged Accounts"
        value={stats.accountsWithViolations}
        icon={AlertTriangle}
        subtitle={`of ${stats.totalPendingPayouts} pending`}
      />
      <StatCard
        title="Avg Payout"
        value={formatCurrency(stats.avgPayoutAmount)}
        icon={DollarSign}
      />
      <StatCard
        title="Avg Deduction"
        value={formatCurrency(stats.avgDeductionPerViolatedAccount)}
        icon={Activity}
        subtitle="per flagged account"
      />
      <StatCard
        title="Blacklisted"
        value={stats.blacklistedAccounts}
        icon={Ban}
        subtitle="accounts on blocklist"
      />
    </div>
  );
}
