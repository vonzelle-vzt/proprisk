import { createAdapter } from './base';

/**
 * TopstepX (ProjectX Gateway) — Futures, raw-data, per-trader (manager=false).
 *
 * Auth:      POST /api/Auth/loginKey {userName, apiKey} → 24h JWT (refresh via
 *            /api/Auth/validate). Scoped to ONE trader's own accounts — no
 *            public firm-wide roster API. Multi-trader = collect each key.
 * Transport: REST (POST under /api) + SignalR (User Hub + Market Hub; JWT via
 *            access_token query string).
 * Base URL:  Topstep — REST api.topstepx.com, hubs rtc.topstepx.com (other
 *            ProjectX firms being sunset toward Topstep-only as of 2026).
 * Data:      POST /api/Account/search (balance, canTrade), /Position/searchOpen,
 *            /Order/search, /Trade/search (realized PnL), /Contract/search.
 *            SignalR pushes GatewayUserAccount/Position/Order/Trade.
 * Risk:      eval rules NOT in API — we COMPUTE trailing max drawdown / daily
 *            loss / position limits from balance + fills (futures engine).
 *            `canTrade=false` is the breach signal.
 * Gotcha:    200 req/60s per endpoint → 429; paid sub; no sandbox.
 * Docs:      https://gateway.docs.projectx.com/
 */
export const topstepxAdapter = createAdapter('topstepx');
