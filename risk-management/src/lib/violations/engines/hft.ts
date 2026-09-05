import { createAdminClient } from '@/lib/supabase/admin';
import { HFT_THRESHOLDS } from '@/config/violations';

interface HFTResult {
  violated: boolean;
  account_id: string;
  threshold_window: number;
  threshold_max: number;
  actual_count: number;
  related_trade_ids: string[];
  details: Record<string, any>;
}

export async function detectHFTViolations(lookbackMinutes: number = 60): Promise<HFTResult[]> {
  const supabase = createAdminClient();
  const results: HFTResult[] = [];
  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString();

  const { data: accounts } = await supabase
    .from('accounts')
    .select('id')
    .eq('is_active', true);

  if (!accounts?.length) return results;

  for (const account of accounts) {
    const { data: recentTrades } = await supabase
      .from('trades')
      .select('id, open_time')
      .eq('account_id', account.id)
      .gte('open_time', since)
      .order('open_time', { ascending: true });

    if (!recentTrades?.length || recentTrades.length < 2) continue;

    for (const threshold of HFT_THRESHOLDS) {
      const windowMs = threshold.window_seconds * 1000;

      for (let i = 0; i < recentTrades.length; i++) {
        const windowStart = new Date(recentTrades[i].open_time).getTime();
        const windowEnd = windowStart + windowMs;
        const tradesInWindow: string[] = [];

        for (let j = i; j < recentTrades.length; j++) {
          const tradeTime = new Date(recentTrades[j].open_time).getTime();
          if (tradeTime > windowEnd) break;
          tradesInWindow.push(recentTrades[j].id);
        }

        if (tradesInWindow.length >= threshold.max_trades) {
          const alreadyFlagged = results.some(
            (r) => r.account_id === account.id && r.related_trade_ids.some((id) => tradesInWindow.includes(id))
          );
          if (!alreadyFlagged) {
            results.push({
              violated: true,
              account_id: account.id,
              threshold_window: threshold.window_seconds,
              threshold_max: threshold.max_trades,
              actual_count: tradesInWindow.length,
              related_trade_ids: tradesInWindow,
              details: {
                window_seconds: threshold.window_seconds,
                max_allowed: threshold.max_trades,
                actual_count: tradesInWindow.length,
                window_start: new Date(windowStart).toISOString(),
                window_end: new Date(windowEnd).toISOString(),
              },
            });
          }
          break;
        }
      }
    }
  }

  return results;
}
