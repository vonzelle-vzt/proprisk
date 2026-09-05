export interface AIChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  intent?: BotIntent;
}

export type BotIntent =
  | 'morning_report'
  | 'pending_payouts'
  | 'account_lookup'
  | 'violations_summary'
  | 'high_risk'
  | 'account_violations'
  | 'account_trades'
  | 'deduction_history'
  | 'security_check'
  | 'risk_score'
  | 'fraud_hunt'
  | 'fraud_report'
  | 'enforcement_queue'
  | 'enforcement_summary'
  | 'repeat_offenders'
  | 'general_question'
  | 'help'
  | 'unknown';

export interface ParsedIntent {
  intent: BotIntent;
  params: Record<string, string>;
  /** True when the regex parser fell back to a generic bucket ('unknown', or
   *  'general_question' matched only by the catch-all question-word / keyword
   *  regexes rather than a specific intent pattern) — signals the caller that
   *  an LLM classification pass is worth trying in live mode. */
  lowConfidence?: boolean;
}

export interface BotResponse {
  response: string;
  intent: BotIntent;
  /** Which path produced `intent`: the regex fast-path, or the Claude
   *  classifier fallback (only engaged in live mode when regex was low-confidence). */
  classifier?: 'regex' | 'llm';
}

export interface MorningReportData {
  pending_payouts: {
    count: number;
    total_amount: number;
  };
  violations: {
    total: number;
    by_type: Record<string, number>;
    accounts_with_violations: number;
  };
  deductions: {
    total_amount: number;
    top_accounts: { accountId: string; login: string; amount: number; plan: string }[];
  };
  security_flags: {
    blacklisted_users: { accountId: string; email: string; reason: string | null }[];
    kyc_failures: number;
    high_risk_count: number;
  };
  top_risk_accounts: { accountId: string; login: string; risk_score: number; reasons: string[] }[];
  severity_distribution: Record<string, number>;
  plan_distribution: { plan: string; count: number; totalPayout: number }[];
  generated_at: string;
}

export interface MorningReport {
  id: string;
  generated_at: string;
  summary: string;
  data: MorningReportData;
}

export interface RiskScoreResult {
  score: number;
  level: 'low' | 'medium' | 'high' | 'critical';
  reasons: string[];
}

export interface AnomalyFlag {
  type: string;
  severity: 'warning' | 'critical';
  description: string;
  accountId: string;
}
