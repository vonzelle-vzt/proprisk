import { createAdminClient } from '@/lib/supabase/admin';
import { MARTINGALE_CONFIG } from '@/config/violations';

interface MartingaleResult {
  violated: boolean;
  account_id: string;
  streak_trades: string[];
  flipping_trade_id: string;
  streak_total_loss: number;
  flipping_profit: number;
  flipping_volume_ratio: number;
  related_trade_ids: string[];
  details: Record<string, any>;
}

export async function detectMartingaleViolations(lookbackHours: number = 24): Promise<MartingaleResult[]> {
  const supabase = createAdminClient();
  const results: MartingaleResult[] = [];
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  const { data: accounts } = await supabase
    .from('accounts')
    .select('id')
    .eq('is_active', true);

  if (!accounts?.length) return results;

  for (const account of accounts) {
    const { data: trades } = await supabase
      .from('trades')
      .select('*')
      .eq('account_id', account.id)
      .gte('close_time', since)
      .not('close_time', 'is', null)
      .order('close_time', { ascending: true });

    if (!trades || trades.length < MARTINGALE_CONFIG.min_losing_trades + 1) continue;

    const streaks = findLosingStreaks(trades);

    for (const streak of streaks) {
      const streakEnd = new Date(streak[streak.length - 1].close_time).getTime();
      const windowEnd = streakEnd + MARTINGALE_CONFIG.flipping_trade_window_hours * 60 * 60 * 1000;

      const totalLoss = streak.reduce((sum: number, t: any) => sum + Math.abs(Math.min(0, t.profit)), 0);
      const avgNotional = streak.reduce((sum: number, t: any) => sum + calculateNotional(t), 0) / streak.length;

      const streakEndIdx = trades.indexOf(streak[streak.length - 1]);
      const candidateFlips = trades.slice(
        streakEndIdx + 1,
        Math.min(streakEndIdx + 1 + MARTINGALE_CONFIG.flipping_trade_window_trades, trades.length)
      ).filter((t: any) => new Date(t.close_time).getTime() <= windowEnd);

      for (const flip of candidateFlips) {
        const flipNotional = calculateNotional(flip);
        const volumeRatio = flipNotional / avgNotional;

        if (volumeRatio >= MARTINGALE_CONFIG.flipping_volume_multiplier && flip.profit >= totalLoss) {
          results.push({
            violated: true,
            account_id: account.id,
            streak_trades: streak.map((t: any) => t.id),
            flipping_trade_id: flip.id,
            streak_total_loss: totalLoss,
            flipping_profit: flip.profit,
            flipping_volume_ratio: volumeRatio,
            related_trade_ids: [...streak.map((t: any) => t.id), flip.id],
            details: {
              streak_length: streak.length,
              avg_notional: avgNotional,
              flip_notional: flipNotional,
              volume_multiplier: volumeRatio,
              total_loss: totalLoss,
              flip_profit: flip.profit,
            },
          });
          break;
        }
      }
    }
  }

  return results;
}

function calculateNotional(trade: any): number {
  const contractSizes: Record<string, number> = {
    forex: 100000,
    commodities_metals: 100,
    indices: 1,
    crypto: 1,
  };
  const contractSize = contractSizes[trade.asset_class] || 100000;
  return trade.lot_size * contractSize * trade.open_price;
}

function findLosingStreaks(trades: any[]): any[][] {
  const streaks: any[][] = [];
  let current: any[] = [];
  let losingCount = 0;

  for (const trade of trades) {
    if (trade.profit < 0) {
      current.push(trade);
      losingCount++;
    } else if (current.length > 0 && losingCount < 4) {
      current.push(trade);
    } else {
      if (losingCount >= 2) streaks.push([...current]);
      current = [];
      losingCount = 0;
    }
  }
  if (losingCount >= 2) streaks.push([...current]);

  return streaks;
}
