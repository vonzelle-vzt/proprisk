export type RiskRuleType =
  | 'max_daily_loss'
  | 'max_position_risk_pct'
  | 'max_consecutive_losses'
  | 'instrument_blocklist';

export type RiskDecisionResult = 'pass' | 'warn' | 'block';
export type RiskSeverity = 'low' | 'medium' | 'high' | 'critical';
export type RiskAlertStatus = 'new' | 'acknowledged' | 'resolved';

export interface RiskRule {
  id: string;
  type: RiskRuleType;
  enabled: boolean;
  threshold: number | null;
  warning_threshold: number | null;
  instrument_list: string[] | null;
}

export interface RiskProfile {
  id: string;
  account_id: string;
  name: string;
  status: 'draft' | 'active' | 'archived';
  version: number;
  rules: RiskRule[];
  created_at: string;
  updated_at: string;
}

export interface PreTradeInput {
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

export interface RiskViolation {
  rule_id: string;
  rule_type: RiskRuleType;
  severity: RiskSeverity;
  message: string;
  current_value: number | string;
  threshold_value: number | string;
}

export interface RiskSuggestion {
  message: string;
  suggested_quantity?: number;
  suggested_stop_loss_price?: number;
}

export interface PreTradeDecision {
  result: RiskDecisionResult;
  risk_amount: number;
  risk_percent: number;
  violations: RiskViolation[];
  suggestions: RiskSuggestion[];
}

export interface RiskTradeEvent {
  id: string;
  account_id: string;
  event_type: string;
  symbol: string | null;
  pnl_delta: number | null;
  exposure_value: number | null;
  quantity: number | null;
  price: number | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
  idempotency_key: string;
}
