import { createAdminClient } from '@/lib/supabase/admin';
import { NEWS_WINDOW_MINUTES } from '@/config/violations';

interface NewsViolationResult {
  violated: boolean;
  account_id: string;
  trade_id: string;
  event_id: string;
  event_name: string;
  event_time: string;
  trade_time: string;
  time_diff_seconds: number;
  related_trade_ids: string[];
  details: Record<string, any>;
}

const SYMBOL_CURRENCY_MAP: Record<string, string[]> = {
  EURUSD: ['EUR', 'USD'], GBPUSD: ['GBP', 'USD'], USDJPY: ['USD', 'JPY'],
  USDCHF: ['USD', 'CHF'], AUDUSD: ['AUD', 'USD'], NZDUSD: ['NZD', 'USD'],
  USDCAD: ['USD', 'CAD'], EURGBP: ['EUR', 'GBP'], EURJPY: ['EUR', 'JPY'],
  GBPJPY: ['GBP', 'JPY'], XAUUSD: ['XAU', 'USD'], XAGUSD: ['XAG', 'USD'],
};

function getCurrenciesForSymbol(symbol: string): string[] {
  const upper = symbol.toUpperCase().replace(/[^A-Z]/g, '');
  if (SYMBOL_CURRENCY_MAP[upper]) return SYMBOL_CURRENCY_MAP[upper];
  if (upper.length >= 6) return [upper.slice(0, 3), upper.slice(3, 6)];
  return [upper];
}

export async function detectNewsViolations(lookbackMinutes: number = 30): Promise<NewsViolationResult[]> {
  const supabase = createAdminClient();
  const results: NewsViolationResult[] = [];
  const now = new Date();
  const windowMs = NEWS_WINDOW_MINUTES * 60 * 1000;
  const since = new Date(now.getTime() - (lookbackMinutes + NEWS_WINDOW_MINUTES) * 60 * 1000).toISOString();

  const { data: events } = await supabase
    .from('news_events')
    .select('*')
    .eq('impact_level', 'red')
    .gte('scheduled_at', since)
    .lte('scheduled_at', new Date(now.getTime() + windowMs).toISOString());

  if (!events?.length) return results;

  const { data: recentTrades } = await supabase
    .from('trades')
    .select('*, accounts!inner(id, is_active)')
    .gte('open_time', since)
    .order('open_time', { ascending: true });

  if (!recentTrades?.length) return results;

  for (const event of events) {
    const eventTime = new Date(event.scheduled_at).getTime();
    const windowStart = eventTime - windowMs;
    const windowEnd = eventTime + windowMs;

    for (const trade of recentTrades) {
      const tradeCurrencies = getCurrenciesForSymbol(trade.symbol);
      if (!tradeCurrencies.includes(event.currency.toUpperCase())) continue;

      const tradeOpenTime = new Date(trade.open_time).getTime();
      const tradeCloseTime = trade.close_time ? new Date(trade.close_time).getTime() : null;

      const openInWindow = tradeOpenTime >= windowStart && tradeOpenTime <= windowEnd;
      const closeInWindow = tradeCloseTime && tradeCloseTime >= windowStart && tradeCloseTime <= windowEnd;

      if (openInWindow || closeInWindow) {
        const relevantTime = openInWindow ? tradeOpenTime : tradeCloseTime!;
        const diffSeconds = Math.abs(relevantTime - eventTime) / 1000;

        results.push({
          violated: true,
          account_id: trade.account_id,
          trade_id: trade.id,
          event_id: event.id,
          event_name: event.event_name,
          event_time: event.scheduled_at,
          trade_time: openInWindow ? trade.open_time : trade.close_time,
          time_diff_seconds: diffSeconds,
          related_trade_ids: [trade.id],
          details: {
            symbol: trade.symbol,
            event_currency: event.currency,
            event_name: event.event_name,
            action: openInWindow ? 'opened' : 'closed',
            time_diff_seconds: diffSeconds,
          },
        });
      }
    }
  }

  return results;
}
