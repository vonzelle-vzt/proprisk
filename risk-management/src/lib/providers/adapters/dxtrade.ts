import { createAdapter } from './base';

/**
 * DXtrade (Devexperts) — Forex/CFD, raw-data, manager.
 *
 * Auth:      Administrative REST + B2B Trading API session (broker/manager
 *            credential → whole book). Not the trader `/dxsca-web` login.
 * Transport: REST + Push API (WebSocket, JSON). FIX available. Per-broker host
 *            `https://<broker-domain>/dxsca-web`.
 * Data:      getAccounts()/getUsers(); getEodMetricsQuery(date, "d:u1,d:u2,…")
 *            for multi-account equity (bulk — avoids N+1); getAccountPortfolios
 *            (ETag change-polling); AccountPortfolio WS push.
 * Risk:      daily-loss/drawdown/news/HFT computed in our engine (not native
 *            REST objects).
 * Docs:      https://demo.dx.trade/developers/
 */
export const dxtradeAdapter = createAdapter('dxtrade', { canEnforce: true });
