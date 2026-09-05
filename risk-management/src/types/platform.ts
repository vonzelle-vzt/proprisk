export interface PlatformTrade {
  _id: string;
  ticket?: string;
  position?: string;
  login: number;
  accountId: number;
  trdSymbol: string;
  stdSymbol: string;
  side: 'Buy' | 'Sell';
  lots: number;
  contractSize?: number;
  qtyInBaseCrncy?: number;
  volumeUSD?: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  openTime: string;
  openPrice: number;
  closeTime: string;
  closePrice: number;
  duration: number;
  profit: number;
  commission: number;
  fee?: number;
  swap: number;
  reason: string;
  comment?: string;
  phase?: number;
  tradeDate?: string;
}

export interface PlatformTradeStats {
  accountId: number;
  totals: {
    totalPnL: number;
    totalVolumeUSD: number;
    totalLots: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    totalCommissions: number;
    totalSwaps: number;
    largestProfitTrade: number;
    largestLossTrade: number;
    averageTradePL: number;
    averageWin: number;
    averageLoss: number;
  };
  winRates: { all: number; long: number; short: number };
  ratios: {
    profitFactor: number;
    sharpeRatio: number;
    sortinoRatio: number;
    tradeExpectancy: number;
  };
  daily: {
    totalTradingDays: number;
    winningDays: number;
    losingDays: number;
    avgDailyPnl: number;
    largestProfitableDay: { day: string; pnl: number } | null;
    largestLosingDay: { day: string; pnl: number } | null;
    maxConsecutiveWinningDays: number;
    maxConsecutiveLosingDays: number;
  };
  streaks: { maxConsecutiveWins: number; maxConsecutiveLosses: number };
  time: {
    avgHoldAll_human: string | null;
    avgHoldWin_human: string | null;
    avgHoldLoss_human: string | null;
    hourOfDayUTC: { hour: number; count: number; pnl: number }[];
  };
  bySymbol: {
    pnl: { symbol: string; pnl: number }[];
    lots: { symbol: string; lots: number }[];
    performance: { symbol: string; trades: number; winRate: number; expectancy: number | null }[];
  };
  bySide: {
    trades: Record<string, number>;
    winRates: Record<string, number>;
    pnl: Record<string, number>;
  };
  drawdowns: { maxDrawdown: number; averageDrawdownLengthTrades: number };
  snapshot: { openTrades: number };
}

export interface PlatformPayout {
  _id: string;
  orderId?: number;
  accountId: string;
  login?: number;
  email?: string;
  customerId?: string;
  userId?: number;
  amount?: number;
  clientPayout?: number;
  fee?: number;
  profitSharePercentage?: number;
  balance?: number;
  totalPnL?: number;
  status?: string;
  requested?: string;
  statusChanged?: string;
  inserted?: string;
  updated?: string;
  date?: string;
  requestDate?: string;
  method?: string;
  destination?: string;
  plan?: string;
  paid?: number;
  rejectionMessage?: string | null;
  certificateUrl?: string | null;
  preApprovedBy?: string | null;
  preApprovedNote?: string | null;
  preApprovedStatus?: number;
  preApprovedTime?: string | null;
  country?: string;
  createdAt?: string;
}

export interface PlatformUser {
  email: string;
  userId: number;
  customerId: string;
  firstName: string;
  lastName: string;
  dob?: string;
  address_1?: string | null;
  address_2?: string | null;
  city?: string;
  state?: string;
  postcode?: string;
  country: string;
  phone?: string;
  regTime?: string;
  isEmailConfirmed?: number;
  isKycVerified: number;
  kycStatus: string;
  kycStatusTime?: string;
  isBlackListed: number;
  blackListTime?: string | null;
  blackListReason?: string | null;
  sumsubId?: string;
  agreementSigned?: number;
  numAccounts?: number;
}

export interface PlatformAccount {
  login: number;
  accountId: number;
  userId: number;
  planId?: number;
  orderId?: number;
  planName: string;
  type?: number;
  status?: number;
  phase?: number;
  broker?: number;
  platform?: number;
  startingBalance: number;
  targetPct?: number;
  maxLossPct?: number;
  dailyLossPct?: number;
  dailyCapPct?: number;
  isMaxLossTrailing?: number;
  isDailyLossSoft?: number;
  isDailyLossBalanceAndEquity?: number;
  isDailyCapBalanceAndEquity?: number;
  consistencyPct?: number;
  minProfitableDays?: number;
  banNewsTrading?: number;
  banMTGL?: number;
  banHFT?: number;
  allowEAs?: number;
  maxOpenLots?: number;
  priorDayEquity?: number;
  priorDayBalance?: number;
  lastEquity?: number;
  lastBalance?: number;
  hwm?: number;
  tradedDays?: number;
  maxDailyProfit?: number;
  meetsConsistency?: number;
  meetsMinProfitableDays?: number;
  payoutTier?: number;
  numApprovedPayouts?: number;
  approvedPayouts?: number;
  profitSharePct?: number;
  payoutDelayDays?: number;
  payoutAllowed?: number;
  addedUTC?: string;
  lastUpdatedUTC?: string;
  pendingPayout?: number;
  lastPayoutTime?: string;
  disabled?: number;
  minTradingDays?: number;
  _balanceAtRequest?: number;
  _maxDailyProfitPrev?: number;
  _curConsistencyPct?: number;
  _tradedToday?: number;
}

export interface PlatformLedgerEvent {
  login: number;
  accountId: number;
  userId: number;
  platform?: number;
  event: string;
  time: string;
  data: Record<string, any>;
  processed?: number;
  processedAt?: string | null;
}

export interface PlatformAccountResponse {
  Data: Record<string, any>;
}

export interface PlatformTradesResponse {
  Data: PlatformTrade[];
}

export interface PlatformPayoutsResponse {
  Data: {
    data: PlatformPayout[];
  };
}
