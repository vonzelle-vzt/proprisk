import { createAdapter } from './base';

/**
 * cTrader (Spotware) — Forex, raw-data, per-trader (manager=false).
 *
 * Auth:      Open API uses end-user OAuth2 (app registered + approved at
 *            openapi.ctrader.com). One token covers only the authorizing
 *            trader's accounts — NO broker super-token. True firm-wide access
 *            requires operating the cServer (Reporting API + Manager's API).
 * Transport: Protocol Buffers (or JSON) over TCP(SSL)/WebSocket; ProtoMessage
 *            envelope. SDKs: OpenApiPy, OpenAPI.Net. FIX 4.4 also available.
 * Base URL:  demo.ctraderapi.com / live.ctraderapi.com (5035 protobuf / 5036
 *            JSON; WSS same host).
 * Data:      ProtoOATrader (balance/leverage), ProtoOAReconcile (positions+
 *            orders), GetPositionUnrealizedPnL, deal lists, symbol specs.
 * Risk:      daily-loss/drawdown/HFT computed in our engine. Limit 50 req/s/conn.
 * Docs:      https://help.ctrader.com/open-api/
 */
export const ctraderAdapter = createAdapter('ctrader');
