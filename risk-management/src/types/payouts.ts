import type { PlatformTrade } from './platform';

export type PayoutStatus = 'Pending' | 'Investigate' | 'Cleared' | 'Rejected' | 'Banned';

export interface PayoutRecord {
  id: string;
  _id?: string;
  customerId?: string;
  userId?: string | number;
  dateRequested?: string;
  orderNumber: string;
  orderId?: string;
  login?: string;
  accountId: string;
  amount?: number;
  clientAmount?: number;
  fee?: number;
  profitSharePercentage?: number;
  email?: string;
  kycStatus: string;
  kycCountry?: string;
  ipMismatch: boolean;
  platformViolations: string[];
  platformTrades?: PlatformTrade[];
  platformDeductions?: PlatformDeductions;
  consistencyAtRequest?: number;
  consistencyRequired?: number;
  dailyCapBalanceEquity?: boolean;
  maxDailyProfitPrev?: number;
  totalProfitAtRequest?: number;
  balanceAtRequest?: number;
  accountSize?: number;
  platformKycCountry?: string;
  address?: string;
  kycRiskLabels?: string[];
  notes: string;
  status: PayoutStatus;
  // New fields from real provider platform API
  plan?: string;
  method?: string;
  destination?: string;
  balance?: number;
  totalPnL?: number;
  firstName?: string;
  lastName?: string;
  country?: string;
  kycVerified?: boolean;
  kycStatusDetail?: string;
  isBlackListed?: boolean;
  tradedDays?: number;
  maxDailyProfit?: number;
  startingBalance?: number;
  banNewsTrading?: boolean;
  banHFT?: boolean;
  banMTGL?: boolean;
  numApprovedPayouts?: number;
  approvedPayouts?: number;
  preApprovedStatus?: number;
  preApprovedBy?: string;
}

export interface PlatformDeductions {
  totalDeductions: number;
  violationCount: number;
  percentOfStartingBalance: number;
  percentOfTotalPL: number;
  breakdownByType: Record<string, number>;
}

export interface IPCheckResult {
  ip: string;
  city: string;
  region: string;
  country: string;
  isp: string;
  isProxy: boolean;
  isVpn: boolean;
  isTor: boolean;
  isDatacenter: boolean;
  source: 'ipapi' | 'ipwho';
}

export interface PayoutSummary {
  total: number;
  ipFlags: number;
  investigations: number;
  totalClientAmount: number;
  violationFlags: number;
  totalDeductions: number;
}

export interface TradeViolation {
  type: string;
  typeKey: string;
  trade: PlatformTrade;
  explanation: string;
  deductionAmount: number;
}

export interface DetailedViolationResult {
  violations: TradeViolation[];
  summary: {
    totalDeductions: number;
    violationTypeCount: Record<string, number>;
    violatingTradeCount: number;
    deductionsByType: Record<string, number>;
  };
  newsEvents?: { title: string; country: string; date: string; impact: string; source: string }[];
}
