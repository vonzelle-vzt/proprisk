export type FraudType =
  | 'copy_ring'
  | 'shared_identity'
  | 'coordinated_payout'
  | 'account_churning'
  | 'profit_manipulation';

export type FraudStatus = 'open' | 'reviewing' | 'confirmed' | 'dismissed' | 'actioned';

export interface FraudInvestigation {
  id: string;
  fraud_type: FraudType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: FraudStatus;
  confidence_score: number;
  account_ids: string[];
  user_ids: string[];
  primary_account: string | null;
  title: string;
  summary: string;
  evidence: FraudEvidence;
  total_amount_at_risk: number;
  recommended_action: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_notes: string | null;
  dedupe_key: string;
  detected_at: string;
  created_at: string;
  updated_at: string;
}

export interface FraudEvidence {
  detector: string;
  run_timestamp: string;

  // Copy Ring
  trade_correlations?: {
    symbol: string;
    account_a: string;
    account_b: string;
    time_lag_seconds: number;
    lot_ratio: number;
    count: number;
  }[];
  correlation_score?: number;

  // Shared Identity
  shared_emails?: { pattern: string; accounts: string[] }[];
  shared_names?: { name: string; accounts: string[] }[];
  shared_countries?: string[];

  // Coordinated Payout
  payout_cluster?: {
    account_id: string;
    requested_at: string;
    amount: number;
  }[];
  cluster_window_minutes?: number;

  // Account Churning
  user_accounts?: {
    user_id: string;
    email: string;
    account_ids: string[];
    total_accounts: number;
    failed_accounts: number;
  }[];

  // Profit Manipulation
  offsetting_trades?: {
    account_a: string;
    account_b: string;
    symbol: string;
    account_a_direction: string;
    account_b_direction: string;
    account_a_pnl: number;
    account_b_pnl: number;
    net_transfer: number;
  }[];
}

export interface FraudFinding {
  account_ids: string[];
  user_ids: string[];
  primary_account: string | null;
  confidence_score: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  summary: string;
  evidence: Partial<FraudEvidence>;
  total_amount_at_risk: number;
  recommended_action: string;
  dedupe_key: string;
}

export interface FraudDetectorResult {
  fraud_type: FraudType;
  findings: FraudFinding[];
}

export interface FraudHunterScanResult {
  scan_id: string;
  started_at: string;
  completed_at: string;
  detectors_run: FraudType[];
  total_findings: number;
  new_investigations: number;
  /** Findings that were discarded because persistence failed (not deduped —
   *  an actual write error). A scan is not "successful" if this is nonzero. */
  persistence_errors: number;
  results: FraudDetectorResult[];
}

export interface FraudHunterConfig {
  copy_ring: {
    min_correlated_trades: number;
    correlation_threshold: number;
    time_window_seconds: number;
    lot_ratio_tolerance: number;
    min_ring_size: number;
  };
  shared_identity: {
    email_similarity_threshold: number;
    check_name_match: boolean;
    check_country_match: boolean;
  };
  coordinated_payout: {
    cluster_window_minutes: number;
    min_cluster_size: number;
    min_total_amount: number;
  };
  account_churning: {
    max_accounts_per_user: number;
    failed_account_threshold: number;
    lookback_days: number;
  };
  profit_manipulation: {
    offset_threshold_pct: number;
    min_offsetting_trades: number;
    time_window_seconds: number;
  };
}
