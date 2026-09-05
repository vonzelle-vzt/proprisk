import { createAdminClient } from '@/lib/supabase/admin';
import { LOT_LIMITS } from '@/config/violations';
import { AccountSize, AssetClass } from '@/types/database';

interface OLResult {
  violated: boolean;
  account_id: string;
  symbol: string;
  asset_class: AssetClass;
  gross_exposure: number;
  limit: number;
  excess_lots: number;
  related_trade_ids: string[];
  details: Record<string, any>;
}

export async function detectOverleveragingViolations(): Promise<OLResult[]> {
  const supabase = createAdminClient();
  const results: OLResult[] = [];

  const { data: accounts } = await supabase
    .from('accounts')
    .select('*')
    .eq('is_active', true);

  if (!accounts?.length) return results;

  for (const account of accounts) {
    const { data: openTrades } = await supabase
      .from('trades')
      .select('*')
      .eq('account_id', account.id)
      .is('close_time', null);

    if (!openTrades?.length) continue;

    const exposureBySymbol = new Map<string, { total: number; asset_class: AssetClass; trade_ids: string[] }>();

    for (const trade of openTrades) {
      const key = trade.symbol;
      const existing = exposureBySymbol.get(key) || { total: 0, asset_class: trade.asset_class as AssetClass, trade_ids: [] };
      existing.total += trade.lot_size;
      existing.trade_ids.push(trade.id);
      exposureBySymbol.set(key, existing);
    }

    const accountSize = account.account_size as AccountSize;
    const limits = LOT_LIMITS[accountSize];
    if (!limits) continue;

    for (const [symbol, exposure] of exposureBySymbol) {
      const limit = limits[exposure.asset_class];
      if (limit === undefined) continue;

      if (exposure.total > limit) {
        results.push({
          violated: true,
          account_id: account.id,
          symbol,
          asset_class: exposure.asset_class,
          gross_exposure: exposure.total,
          limit,
          excess_lots: exposure.total - limit,
          related_trade_ids: exposure.trade_ids,
          details: {
            account_size: accountSize,
            asset_class: exposure.asset_class,
            symbol,
            open_positions_count: exposure.trade_ids.length,
          },
        });
      }
    }
  }

  return results;
}
