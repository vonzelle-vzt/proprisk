import { createAdapter } from './base';

/**
 * CQG (WebAPI) — Futures, raw-data, manager (ALL_AUTHORIZED).
 *
 * Auth:      Logon message (username + password + CQG client_app_id +
 *            private_label + client_version), or access_token/partner_token.
 *            A login is authorized over a set of accounts (FCM/CAST perms).
 * Transport: WebAPI = Protocol Buffers over secure WebSocket (WSS, TLS 1.2/1.3)
 *            — recommended for a server dashboard. Also FIX Connect + Drop Copy.
 * Base URL:  demo wss://demoapi.cqg.com:443 / prod wss://api.cqg.com:443.
 * Data:      TradeSubscription scopes (OR-able): ORDERS, POSITIONS,
 *            ACCOUNT_SUMMARY (total_margin, current_balance, profit_loss, ote=
 *            unrealized PnL), EXCHANGE_BALANCES. PUBLICATION_TYPE_ALL_AUTHORIZED
 *            + account_filter streams the whole firm in one session.
 * Risk:      SPAN-like margin readable; CAST enforces limits server-side.
 * Gating:    FCM environment + signed exchange agreements + conformance; proto
 *            access gated (NDA). Samples: cqg/WebAPIPythonSamples.
 * Docs:      https://help.cqg.com/apihelp/
 */
export const cqgAdapter = createAdapter('cqg', { canEnforce: true });
