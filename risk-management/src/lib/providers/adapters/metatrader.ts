import { createAdapter } from './base';

/**
 * MetaTrader 4/5 (MetaQuotes) — Forex, raw-data, manager.
 *
 * Auth:      Native Manager API = manager login# + password + broker server
 *            (inherently multi-account within group rights). MT5 Web API =
 *            challenge-response → AES-256 session.
 * Transport: NO official cloud REST. Native C++/.NET DLL (MT5APIManager.dll /
 *            mtmanapi.dll); Web API = binary over TCP. Realtime via Manager API
 *            "pumping mode" sink callbacks (OnUser/Position/DealUpdate).
 * Bridge:    MetaApi (metaapi.cloud) gives REST+WS + a Risk Management API, but
 *            per-account provisioning (investor pw=monitor / master=enforce),
 *            max 300 accounts/server/user. Realistic cloud interim.
 * Gating:    Server license + signed NDA + IP allowlist + broker relationship.
 * Risk:      daily-loss (midnight equity), drawdown (own high-water mark),
 *            HFT (holding time) computed in our engine. Enforce via rights/group.
 * Docs:      https://metaapi.cloud/docs/
 */
export const metatraderAdapter = createAdapter('metatrader', { canEnforce: true });
