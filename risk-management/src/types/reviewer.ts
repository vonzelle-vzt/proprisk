export type ReviewerStatus = 'pending_review' | 'deduction_confirmed' | 'pending_deduction' | 'review_error';

export interface ReviewerRunResult {
  run_id: string;
  started_at: string;
  completed_at: string;
  total_cases: number;
  confirmed: number;
  pending_deduction: number;
  errors: number;
  skipped: number;
  platform_healthy: boolean;
}

export interface ReviewCase {
  enforcement_id: string;
  account_id: string;
  violation_type: string;
  recommended_amount: number;
  action_type: string;
  status: string;
  created_at: string;
  payout_ref?: string;
}

export interface DeductionMatch {
  matched: boolean;
  match_source: 'violation_summary' | 'ledger_event' | 'none';
  platform_amount?: number;
  ledger_event_time?: string;
  notes: string;
}
