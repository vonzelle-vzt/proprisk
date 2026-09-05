/**
 * Normalized, cross-asset data model.
 *
 * Every trading-platform adapter (MatchTrader, DXtrade, TradeLocker,
 * cTrader, MT4/MT5, Tradovate, Rithmic, TopstepX, CQG, NinjaTrader) maps its
 * native shapes onto these types so the dashboard, risk engines and mock data
 * are platform-agnostic and work identically for Forex and Futures.
 */

export type AssetClass = 'forex' | 'futures';

/** Position-size unit: forex trades in lots, futures in contracts. */
export type SizeUnit = 'lots' | 'contracts';

/** How an adapter sources risk violations. */
export type ProviderKind =
  | 'native-violations' // platform computes breaches server-side (MatchTrader, Tradovate, Rithmic, CQG)
  | 'raw-data'; //         we pull raw trades/equity and compute breaches in our engine

export type ProviderId =
  // forex
  | 'matchtrader'
  | 'dxtrade'
  | 'tradelocker'
  | 'ctrader'
  | 'metatrader'
  // futures
  | 'tradovate'
  | 'rithmic'
  | 'topstepx'
  | 'cqg'
  | 'ninjatrader';

/** Forex + futures violation taxonomy (superset of the legacy forex set). */
export type NormalizedViolationType =
  // forex (mirror of src/types/database.ts ViolationType)
  | 'overleveraging'
  | 'hft'
  | 'martingale'
  | 'news'
  | 'grid'
  | 'copy'
  // futures-specific
  | 'daily_loss'
  | 'trailing_drawdown'
  | 'position_limit'
  | 'eod_flat';

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type AccountPhase = 'challenge' | 'verification' | 'funded';
export type AccountStatus = 'active' | 'restricted' | 'suspended' | 'breached' | 'closed';

export interface NormalizedUser {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  country: string;
  kycStatus: string;
  isBlackListed: boolean;
}

export interface NormalizedAccount {
  id: string; // stable id within provider
  provider: ProviderId;
  providerLabel: string;
  assetClass: AssetClass;
  login: string;
  email: string;
  firstName: string;
  lastName: string;
  country: string;
  kycStatus: string;
  isBlackListed: boolean;
  plan: string;
  phase: AccountPhase;
  status: AccountStatus;
  /** Whether the trader is currently allowed to trade (futures `canTrade`). */
  canTrade: boolean;
  startingBalance: number;
  balance: number;
  equity: number;
  totalPnL: number;
  /** Risk configuration (asset-class dependent; may be 0/undefined if N/A). */
  maxDailyLossPct: number;
  maxTrailingDrawdownPct: number;
  maxPositionSize: number; // lots (forex) or contracts (futures)
  sizeUnit: SizeUnit;
  banNewsTrading: boolean;
  banHFT: boolean;
  banMartingale: boolean;
  tradedDays: number;
}

export interface NormalizedTrade {
  id: string;
  accountId: string;
  provider: ProviderId;
  assetClass: AssetClass;
  symbol: string;
  side: 'Buy' | 'Sell';
  /** Native size in `sizeUnit` — lots for forex, contracts for futures. */
  sizeNative: number;
  sizeUnit: SizeUnit;
  notionalUSD: number;
  openTime: string;
  closeTime: string;
  openPrice: number;
  closePrice: number;
  durationSec: number;
  profit: number;
  commission: number;
  swap: number;
}

export interface NormalizedViolation {
  id: string;
  accountId: string;
  type: NormalizedViolationType;
  label: string;
  assetClass: AssetClass;
  severity: Severity;
  detectedAt: string;
  description: string;
  deductionAmount: number;
  affectedTradeIds: string[];
  status: 'detected' | 'confirmed' | 'deducted' | 'dismissed';
}

export interface NormalizedPayout {
  id: string;
  accountId: string;
  login: string;
  email: string;
  amount: number;
  clientAmount: number;
  status: string;
  requestedAt: string;
}

export interface NormalizedRiskSummary {
  accountId: string;
  totalDeductions: number;
  violationCount: number;
  breakdownByType: Record<string, number>;
  severity: Severity;
}

/** A trader's full risk picture, used by builders and the analysis views. */
export interface NormalizedAnalysis {
  account: NormalizedAccount;
  trades: NormalizedTrade[];
  violations: NormalizedViolation[];
  summary: NormalizedRiskSummary;
}

/** Human labels for every violation type, forex + futures. */
export const VIOLATION_LABELS: Record<NormalizedViolationType, string> = {
  overleveraging: 'Overleveraging',
  hft: 'HFT',
  martingale: 'Martingale',
  news: 'News Trading',
  grid: 'Grid Trading',
  copy: 'Copy Trading',
  daily_loss: 'Daily Loss Limit',
  trailing_drawdown: 'Trailing Drawdown',
  position_limit: 'Position Limit',
  eod_flat: 'End-of-Day Flat',
};

export function severityFromDeduction(amount: number): Severity {
  return amount > 500 ? 'critical' : amount > 200 ? 'high' : amount > 50 ? 'medium' : 'low';
}
