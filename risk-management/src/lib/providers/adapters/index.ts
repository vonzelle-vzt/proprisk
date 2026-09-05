import type { AssetClass, ProviderId } from '../types';
import type { TradingProvider } from '../interface';
import { getConfiguredProviderIds, getDefaultProviderId, metaForAssetClass } from '../registry';

import { matchtraderAdapter } from './matchtrader';
import { dxtradeAdapter } from './dxtrade';
import { tradelockerAdapter } from './tradelocker';
import { ctraderAdapter } from './ctrader';
import { metatraderAdapter } from './metatrader';
import { tradovateAdapter } from './tradovate';
import { rithmicAdapter } from './rithmic';
import { topstepxAdapter } from './topstepx';
import { cqgAdapter } from './cqg';
import { ninjatraderAdapter } from './ninjatrader';

/** Registry of all platform adapters, keyed by provider id. */
export const ADAPTERS: Record<ProviderId, TradingProvider> = {
  matchtrader: matchtraderAdapter,
  dxtrade: dxtradeAdapter,
  tradelocker: tradelockerAdapter,
  ctrader: ctraderAdapter,
  metatrader: metatraderAdapter,
  tradovate: tradovateAdapter,
  rithmic: rithmicAdapter,
  topstepx: topstepxAdapter,
  cqg: cqgAdapter,
  ninjatrader: ninjatraderAdapter,
};

export function getProvider(id: ProviderId): TradingProvider {
  return ADAPTERS[id];
}

/** All adapters for an asset class (for the Integrations page / aggregation). */
export function getProvidersForAssetClass(assetClass: AssetClass): TradingProvider[] {
  return metaForAssetClass(assetClass).map((m) => ADAPTERS[m.id]);
}

/**
 * The adapters a live aggregation should query: configured providers for the
 * asset class, falling back to the default provider (MatchTrader for forex,
 * Tradovate for futures) so the system always has a source.
 */
export function getActiveProviders(assetClass: AssetClass): TradingProvider[] {
  const configured = getConfiguredProviderIds(assetClass);
  const ids = configured.length > 0 ? configured : [getDefaultProviderId(assetClass)];
  return ids.map((id) => ADAPTERS[id]);
}
