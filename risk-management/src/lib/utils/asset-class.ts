import type { AssetClass } from '@/types/database';

const CRYPTOS = ['BTC', 'ETH', 'LTC', 'XRP', 'ADA', 'DOT', 'SOL', 'DOGE', 'LINK', 'UNI'];
const METALS = ['XAU', 'XAG', 'GOLD', 'SILVER', 'COPPER'];
const INDICES = ['US30', 'US500', 'USTEC', 'NAS100', 'SPX500', 'DJ30', 'DAX', 'FTSE', 'NKY', 'AUS200'];

export function classifyAsset(symbol: string): AssetClass {
  const upper = symbol.toUpperCase();
  if (CRYPTOS.some(c => upper.includes(c))) return 'crypto';
  if (METALS.some(m => upper.includes(m))) return 'commodities_metals';
  if (INDICES.some(i => upper.includes(i))) return 'indices';
  return 'forex';
}
