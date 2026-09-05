import { createAdapter } from './base';

/**
 * Rithmic (R | Protocol / R | API+) — Futures, native-violations, manager.
 * The dominant futures rail for prop firms; RMS enforces rules server-side.
 *
 * Auth:      WebSocket login handshake (user + password + system_name +
 *            app_name + app_version + gateway url), TLS WSS. Multi-account via
 *            fcm_id / ib_id / account_id on account-scoped requests; an FCM/IB
 *            relationship can administer thousands of accounts.
 * Transport: Protocol Buffers over WebSocket ("RProtocol") across 4 plants:
 *            TICKER, ORDER, HISTORY, PNL (each own login/heartbeat). Also
 *            R | API+ (C++/.NET). Community refs: async_rithmic, rithmic-rs.
 * Data:      PNL plant — balance/equity/realized+unrealized PnL/positions, both
 *            snapshot (list_account_summary) and stream (subscribe_to_pnl_updates).
 *            ORDER plant — accounts, orders, fills. RMS margin/limits protos.
 * Risk:      RMS auto-liquidation (trailing min balance = trailing DD, loss
 *            limits, profit targets, EOD DD, position limits) — map to violations.
 * Gating:    mandatory conformance test + FCM relationship; prod gateway URLs
 *            confidential. Dev: "Rithmic Test" @ rituz00100.rithmic.com:443.
 * Docs:      https://www.rithmic.com/apis
 */
export const rithmicAdapter = createAdapter('rithmic', { canEnforce: true });
