import { createAdminClient } from '@/lib/supabase/admin';
import { GRID_TRADING_CONFIG } from '@/config/violations';

interface GridTradeMatch {
  account_a_trade_id: string;
  account_b_trade_id: string;
  symbol: string;
  time_diff_seconds: number;
  lot_size_diff_pct: number;
  price_diff: number;
}

interface GridResult {
  violated: boolean;
  account_a_id: string;
  account_b_id: string;
  score: number;
  matched_trades: GridTradeMatch[];
  cumulative_profit_transfer: number;
  related_trade_ids: string[];
  details: Record<string, any>;
}

export async function detectGridTradingViolations(lookbackHours: number = 24): Promise<GridResult[]> {
  const supabase = createAdminClient();
  const results: GridResult[] = [];
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  const { data: recentTrades } = await supabase
    .from('trades')
    .select('*, accounts!inner(id, user_profile_id)')
    .gte('open_time', since)
    .order('open_time', { ascending: true });

  if (!recentTrades?.length) return results;

  const tradesByAccount = new Map<string, any[]>();
  for (const trade of recentTrades) {
    const accountId = trade.account_id;
    if (!tradesByAccount.has(accountId)) tradesByAccount.set(accountId, []);
    tradesByAccount.get(accountId)!.push(trade);
  }

  const accountIds = Array.from(tradesByAccount.keys());
  const checkedPairs = new Set<string>();

  for (let i = 0; i < accountIds.length; i++) {
    for (let j = i + 1; j < accountIds.length; j++) {
      const aId = accountIds[i];
      const bId = accountIds[j];
      const pairKey = [aId, bId].sort().join(':');
      if (checkedPairs.has(pairKey)) continue;
      checkedPairs.add(pairKey);

      const aTrades = tradesByAccount.get(aId)!;
      const bTrades = tradesByAccount.get(bId)!;

      const matches: GridTradeMatch[] = [];
      const usedB = new Set<string>();

      for (const aT of aTrades) {
        for (const bT of bTrades) {
          if (usedB.has(bT.id)) continue;
          if (aT.symbol !== bT.symbol) continue;
          if (aT.direction === bT.direction) continue;

          const timeDiff = Math.abs(new Date(aT.open_time).getTime() - new Date(bT.open_time).getTime()) / 1000;
          if (timeDiff > GRID_TRADING_CONFIG.time_window_seconds) continue;

          const lotDiff = Math.abs(aT.lot_size - bT.lot_size) / Math.max(aT.lot_size, bT.lot_size);
          if (lotDiff > GRID_TRADING_CONFIG.lot_size_tolerance) continue;

          const priceDiff = Math.abs(aT.open_price - bT.open_price);

          matches.push({
            account_a_trade_id: aT.id,
            account_b_trade_id: bT.id,
            symbol: aT.symbol,
            time_diff_seconds: timeDiff,
            lot_size_diff_pct: lotDiff,
            price_diff: priceDiff,
          });
          usedB.add(bT.id);
          break;
        }
      }

      if (matches.length < GRID_TRADING_CONFIG.min_mirrored_trades) continue;

      const avgTimeDiff = matches.reduce((s, m) => s + m.time_diff_seconds, 0) / matches.length;
      const avgLotDiff = matches.reduce((s, m) => s + m.lot_size_diff_pct, 0) / matches.length;
      const frequencyScore = Math.min(matches.length / 10, 1);
      const timingScore = 1 - Math.min(avgTimeDiff / GRID_TRADING_CONFIG.time_window_seconds, 1);
      const lotScore = 1 - avgLotDiff;

      const matchedAIds = new Set(matches.map(m => m.account_a_trade_id));
      const matchedBIds = new Set(matches.map(m => m.account_b_trade_id));
      const aProfits = aTrades.filter((t: any) => matchedAIds.has(t.id)).reduce((s: number, t: any) => s + t.profit, 0);
      const bProfits = bTrades.filter((t: any) => matchedBIds.has(t.id)).reduce((s: number, t: any) => s + t.profit, 0);
      const profitImbalance = Math.abs(aProfits - bProfits) / (Math.abs(aProfits) + Math.abs(bProfits) + 0.01);

      const score = (frequencyScore * 0.3 + timingScore * 0.3 + lotScore * 0.2 + profitImbalance * 0.2);

      if (score >= GRID_TRADING_CONFIG.score_threshold) {
        results.push({
          violated: true,
          account_a_id: aId,
          account_b_id: bId,
          score,
          matched_trades: matches,
          cumulative_profit_transfer: Math.abs(aProfits - bProfits),
          related_trade_ids: [
            ...matches.map(m => m.account_a_trade_id),
            ...matches.map(m => m.account_b_trade_id),
          ],
          details: {
            match_count: matches.length,
            avg_time_diff: avgTimeDiff,
            avg_lot_diff: avgLotDiff,
            frequency_score: frequencyScore,
            timing_score: timingScore,
            lot_score: lotScore,
            profit_imbalance: profitImbalance,
            account_a_profit: aProfits,
            account_b_profit: bProfits,
          },
        });
      }
    }
  }

  return results;
}
