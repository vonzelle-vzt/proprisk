import { ViolationType, ChallengeType, Phase, AccountSize } from './database';

export interface DateRangeFilter {
  start_date: string;
  end_date: string;
}

export interface DeductionsSummaryParams extends DateRangeFilter {
  violation_type?: ViolationType;
  account_size?: AccountSize;
  challenge_type?: ChallengeType;
}

export interface ViolationReportParams extends DateRangeFilter {
  violation_type?: ViolationType;
  account_login?: string;
  status?: string;
  page?: number;
  per_page?: number;
}

export interface ManualDeductionRequest {
  account_id: string;
  amount: number;
  reason: string;
}

export interface ManualEmailRequest {
  account_id: string;
  subject: string;
  body: string;
  violation_id?: string;
  deduction_id?: string;
}

export interface DeductionBreakdown {
  by_violation_type: { type: ViolationType; count: number; total_amount: number }[];
  by_account_size: { size: AccountSize; count: number; total_amount: number }[];
  by_challenge_type: { type: ChallengeType; count: number; total_amount: number }[];
}

export interface DeductionTimeSeriesPoint {
  date: string;
  count: number;
  total_amount: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface PreTradeEvaluateRequest {
  account_id: string;
  symbol: string;
  direction: 'buy' | 'sell';
  entry_price: number;
  stop_loss_price: number;
  quantity: number;
  account_balance: number;
  open_exposure_value: number;
  daily_realized_pnl: number;
  consecutive_losses: number;
}

export interface CreateRiskProfileRequest {
  account_id: string;
  name: string;
  status?: 'draft' | 'active' | 'archived';
  rules: Array<{
    id?: string;
    type: 'max_daily_loss' | 'max_position_risk_pct' | 'max_consecutive_losses' | 'instrument_blocklist';
    enabled: boolean;
    threshold?: number | null;
    warning_threshold?: number | null;
    instrument_list?: string[] | null;
  }>;
}
