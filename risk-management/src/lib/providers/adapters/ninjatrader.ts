import { createAdapter } from './base';

/**
 * NinjaTrader — Futures, raw-data, per-trader (manager=false).
 *
 * IMPORTANT: NinjaTrader's desktop APIs (ATI/NtDirect over localhost:36973,
 * NinjaScript C# add-ons) are LOCAL-ONLY and cannot be aggregated server-side —
 * no auth, only the local terminal's accounts. There is no remote way to query
 * an arbitrary trader's desktop.
 *
 * The real multi-account "cloud" path for NinjaTrader-fronted firms IS the
 * Tradovate API (NinjaTrader acquired Tradovate) — see `tradovate.ts`. Firms on
 * Rithmic/CQG rails with NT as a front-end should integrate those directly.
 *
 * This adapter therefore exists for completeness/coverage in the demo; in
 * production, route NinjaTrader firms to their actual rail.
 * Docs: https://ninjatrader.com/support/helpguides/nt8/
 */
export const ninjatraderAdapter = createAdapter('ninjatrader');
