export type ViolationType = 'overleveraging' | 'hft' | 'martingale' | 'news' | 'grid' | 'copy';
export type ChallengeType = 'pro' | 'flex' | '1_phase';
export type Phase = 'challenge' | 'verification' | 'funded';
export type AccountSize = 2500 | 5000 | 10000 | 25000 | 50000 | 100000 | 200000 | 300000;
export type AssetClass = 'commodities_metals' | 'indices' | 'crypto' | 'forex';
export type TradeDirection = 'buy' | 'sell';
export type ViolationStatus = 'detected' | 'confirmed' | 'deducted' | 'dismissed' | 'under_review';
export type DeductionExecutionType = 'automatic' | 'manual';
export type EmailStatus = 'sent' | 'failed' | 'pending';

export interface Account {
  id: string;
  login: string;
  user_profile_id: string;
  account_size: AccountSize;
  challenge_type: ChallengeType;
  phase: Phase;
  balance: number;
  equity: number;
  starting_day_balance: number;
  starting_day_equity: number;
  email: string;
  trader_name: string;
  created_at: string;
  updated_at: string;
}

export interface Trade {
  id: string;
  account_id: string;
  trade_id_external: string;
  symbol: string;
  asset_class: AssetClass;
  direction: TradeDirection;
  lot_size: number;
  open_price: number;
  close_price: number | null;
  open_time: string;
  close_time: string | null;
  profit: number;
  swap: number;
  commission: number;
  comment: string | null;
  magic_number: number | null;
  created_at: string;
}

export interface Violation {
  id: string;
  account_id: string;
  violation_type: ViolationType;
  detected_at: string;
  status: ViolationStatus;
  severity: 'low' | 'medium' | 'high' | 'critical';
  details_json: Record<string, any>;
  related_trade_ids: string[];
  deduction_amount: number;
  phase: Phase;
  challenge_type: ChallengeType;
  account_size: AccountSize;
  created_at: string;
  account?: Account;
  trades?: Trade[];
  deductions?: Deduction[];
  emails?: Email[];
}

export interface Deduction {
  id: string;
  violation_id: string | null;
  account_id: string;
  amount: number;
  pre_balance: number;
  post_balance: number;
  executed_by: string;
  execution_type: DeductionExecutionType;
  reason: string;
  approved_by: string | null;
  executed_at: string;
  created_at: string;
  account?: Account;
  violation?: Violation;
}

export interface Email {
  id: string;
  account_id: string;
  violation_id: string | null;
  deduction_id: string | null;
  recipient: string;
  subject: string;
  body: string;
  template_type: ViolationType | 'manual' | 'custom';
  sent_by: string;
  sent_at: string;
  sendgrid_message_id: string | null;
  status: EmailStatus;
  created_at: string;
}

export interface AuditLogEntry {
  id: string;
  action_type: string;
  entity_type: string;
  entity_id: string;
  performed_by: string;
  details_json: Record<string, any>;
  prev_hash?: string | null;
  entry_hash?: string | null;
  created_at: string;
}

export interface NewsEvent {
  id: string;
  event_name: string;
  currency: string;
  impact_level: 'red' | 'orange' | 'yellow';
  scheduled_at: string;
  source: 'forex_factory' | 'fxstreet';
  created_at: string;
}

export interface ViolationConfig {
  id: string;
  violation_type: ViolationType;
  config_key: string;
  config_value: string;
  challenge_type: ChallengeType | null;
  account_size: AccountSize | null;
  phase: Phase | null;
  active: boolean;
  updated_at: string;
}
