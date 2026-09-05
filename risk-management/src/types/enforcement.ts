export type EnforcementActionType = 'deduction' | 'payout_hold' | 'account_restriction' | 'escalation' | 'warning';
export type EnforcementStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'expired' | 'auto_escalated';
export type EscalationLevel = 'normal' | 'elevated' | 'urgent' | 'critical';

export interface EnforcementRecommendation {
  id: string;
  account_id: string;
  violation_id: string | null;
  violation_type: string;
  action_type: EnforcementActionType;
  status: EnforcementStatus;
  severity_score: number;
  escalation_level: EscalationLevel;
  recommended_amount: number;
  recommendation_reason: string;
  recommendation_details: RecommendationDetails;
  prior_violation_count: number;
  repeat_multiplier: number;
  decided_by: string | null;
  decided_at: string | null;
  decision_notes: string | null;
  executed_at: string | null;
  execution_result: Record<string, unknown> | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  // Reviewer agent fields
  reviewer_status: string | null;
  reviewer_notes: string | null;
  reviewed_at: string | null;
  email_sent_at: string | null;
  payout_ref: string | null;
}

export interface RecommendationDetails {
  base_amount: number;
  repeat_multiplier: number;
  severity_factors: string[];
  suggested_restrictions?: string[];
  related_payout_ids?: string[];
  account_context?: {
    plan: string;
    balance: number;
    total_prior_deductions: number;
  };
}

export interface AccountViolationHistory {
  id: string;
  account_id: string;
  violation_type: string;
  total_count: number;
  last_violation_at: string | null;
  total_deduction_amount: number;
  escalation_tier: number;
  count_last_24h: number;
  count_last_7d: number;
  count_last_30d: number;
  updated_at: string;
}

export interface SeverityFactor {
  name: string;
  points: number;
  description: string;
}

export interface SeverityAssessment {
  score: number;
  escalation_level: EscalationLevel;
  factors: SeverityFactor[];
  recommended_actions: RecommendedAction[];
}

export interface RecommendedAction {
  action_type: EnforcementActionType;
  amount: number;
  reason: string;
  priority: number;
}

export interface EnforcementQueueSummary {
  total_pending: number;
  by_escalation: Record<EscalationLevel, number>;
  by_action_type: Record<EnforcementActionType, number>;
  by_violation_type: Record<string, number>;
  total_recommended_amount: number;
  oldest_pending_at: string | null;
  by_reviewer_status?: Record<string, number>;
}

export interface BatchDecision {
  recommendation_ids: string[];
  decision: 'approved' | 'rejected';
  decided_by: string;
  notes?: string;
}
