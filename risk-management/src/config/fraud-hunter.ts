import type { FraudHunterConfig } from '@/types/fraud';

export const FRAUD_HUNTER_CONFIG: FraudHunterConfig = {
  copy_ring: {
    min_correlated_trades: 5,
    correlation_threshold: 0.7,
    time_window_seconds: 120,
    lot_ratio_tolerance: 0.15,
    min_ring_size: 2,
  },
  shared_identity: {
    email_similarity_threshold: 0.85,
    check_name_match: true,
    check_country_match: true,
  },
  coordinated_payout: {
    cluster_window_minutes: 60,
    min_cluster_size: 3,
    min_total_amount: 1000,
  },
  account_churning: {
    max_accounts_per_user: 5,
    failed_account_threshold: 3,
    lookback_days: 90,
  },
  profit_manipulation: {
    offset_threshold_pct: 0.80,
    min_offsetting_trades: 3,
    time_window_seconds: 300,
  },
};
