import { AccountSize, AssetClass } from '@/types/database';

export const LOT_LIMITS: Record<AccountSize, Record<AssetClass, number>> = {
  2500:   { commodities_metals: 0.15, indices: 1,  crypto: 0.02, forex: 1  },
  5000:   { commodities_metals: 0.15, indices: 1,  crypto: 0.02, forex: 1  },
  10000:  { commodities_metals: 0.30, indices: 2,  crypto: 0.05, forex: 2  },
  25000:  { commodities_metals: 0.75, indices: 5,  crypto: 0.15, forex: 5  },
  50000:  { commodities_metals: 1.5,  indices: 10, crypto: 0.25, forex: 10 },
  100000: { commodities_metals: 3,    indices: 20, crypto: 0.50, forex: 20 },
  200000: { commodities_metals: 6,    indices: 40, crypto: 1,    forex: 40 },
  300000: { commodities_metals: 9,    indices: 60, crypto: 1.5,  forex: 60 },
};

export const HFT_THRESHOLDS = [
  { window_seconds: 3,    max_trades: 2  },
  { window_seconds: 10,   max_trades: 3  },
  { window_seconds: 30,   max_trades: 5  },
  { window_seconds: 60,   max_trades: 6  },
  { window_seconds: 3600, max_trades: 30 },
];

export const NEWS_WINDOW_MINUTES = 5;

export const MARTINGALE_CONFIG = {
  min_losing_trades: 2,
  flipping_trade_window_hours: 3,
  flipping_trade_window_trades: 3,
  flipping_volume_multiplier: 1.5,
};

export const GRID_TRADING_CONFIG = {
  time_window_seconds: 60,
  lot_size_tolerance: 0.10,
  min_mirrored_trades: 3,
  score_threshold: 0.75,
};

export const COPY_TRADING_CONFIG = {
  lag_window_seconds: 60,
  lot_size_tolerance: 0.10,
  min_copied_trades: 5,
  score_threshold: 0.70,
};

/**
 * Futures risk configuration. Unlike forex (lot limits / news windows), futures
 * prop evals are governed by account-level drawdown and contract limits. These
 * are sensible defaults; per-firm values come from the account's eval plan and
 * (when live) from the provider's risk API (Tradovate auto-liq, Rithmic RMS, CQG).
 */
export const FUTURES_CONFIG = {
  // % of starting balance lost in a single trading day before breach.
  default_max_daily_loss_pct: 0.04,
  // Trailing peak-to-trough equity drawdown before breach.
  default_max_trailing_drawdown_pct: 0.05,
  // Max concurrent contracts by account size (USD → contracts).
  position_limits_by_size: {
    25000: 5,
    50000: 5,
    100000: 10,
    150000: 15,
  } as Record<number, number>,
  // Positions still open after this UTC hour count as end-of-day-flat breaches.
  eod_flat_hour_utc: 21, // ~4pm ET CME close
} as const;

export const FUTURES_VIOLATION_LABELS: Record<string, string> = {
  daily_loss: 'Daily Loss Limit',
  trailing_drawdown: 'Trailing Drawdown',
  position_limit: 'Position Limit',
  eod_flat: 'End-of-Day Flat',
};

export const VIOLATION_LABELS: Record<string, string> = {
  'overleveraging': 'Overleveraging',
  'hft': 'HFT',
  'martingale': 'Martingale',
  'news': 'News Trading',
  'grid': 'Grid Trading',
  'copy': 'Copy Trading',
  'violations': 'Violations',
  'overnight': 'Overnight',
};
