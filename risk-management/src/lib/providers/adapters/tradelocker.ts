import { createAdapter } from './base';

/**
 * TradeLocker — Forex, raw-data, manager. Best-fit for a risk desk.
 *
 * Auth:      Brand API key (`brand-api-key` header) — read-only (monitor) or
 *            read-write (enforce) tiers. Issued after commercial agreement.
 * Transport: REST + Socket.IO. BrandSocket (`wss://api.tradelocker.com/
 *            brand-socket/...`) pushes full state of ALL accounts → SyncEnd →
 *            deltas. Prefer it over polling (rate limit 100 req / 10s).
 * Data:      /brand (all accounts), /details?withRiskDetails=true (leverage),
 *            /get-open-positions, report endpoints. BrandSocket AccountStatus
 *            streams balance/equity/margin/per-position PnL.
 * Enforce:   /restrict, /suspend, /set-status, /close-all-positions, /activate.
 * Gotcha:    position/order PnL is in quote currency — convert to account ccy.
 * Docs:      https://brand-docs.tradelocker.com/
 */
export const tradelockerAdapter = createAdapter('tradelocker', { canEnforce: true });
