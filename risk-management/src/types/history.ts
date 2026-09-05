import type { PayoutRecord } from './payouts';

export type PayoutDecision = 'approved' | 'rejected' | 'pending';

export interface PayoutHistoryRecord {
  id: string;
  platformPayoutId: string;
  platformAccountId: string;
  platformOrderId?: string;
  login?: string;
  customerId?: string;
  userId?: string;

  decision: PayoutDecision;
  decidedBy: string;
  decidedAt: string;
  decisionNotes?: string;

  amount?: number;
  clientAmount?: number;
  fee?: number;
  profitSharePct?: number;
  method?: string;
  plan?: string;
  dateRequested?: string;

  balance?: number;
  totalPnl?: number;
  startingBalance?: number;
  tradedDays?: number;

  email?: string;
  firstName?: string;
  lastName?: string;
  country?: string;
  kycStatus?: string;
  kycVerified?: boolean;
  isBlacklisted?: boolean;

  preApprovedStatus?: number;
  preApprovedBy?: string;

  violationsList: string[];
  deductionsTotal: number;
  deductionsViolationCount: number;
  deductionsByType: Record<string, number>;

  fullSnapshot: PayoutRecord;
  createdAt: string;
}

export interface PayoutHistorySummary {
  totalApproved: number;
  totalRejected: number;
  totalAmountPaid: number;
  avgPayout: number;
  totalDeductions: number;
}
