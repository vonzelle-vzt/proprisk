import { createAdminClient } from '@/lib/supabase/admin';
import { COPY_TRADING_CONFIG } from '@/config/violations';

interface CopyTradeMatch {
  leader_trade_id: string;
  follower_trade_id: string;
  symbol: string;
  lag_seconds: number;
  lot_size_diff_pct: number;
  price_diff: number;
}

interface CopyResult {
  violated: boolean;
  leader_account_id: string;
  follower_account_id: string;
  score: number;
  matched_trades: CopyTradeMatch[];
  related_trade_ids: string[];
  details: Record<string, any>;
}

export async function detectCopyTradingViolations(lookbackHours: number = 24): Promise<CopyResult[]> {
  const supabase = createAdminClient();
  const results: CopyResult[] = [];
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  const { data: recentTrades } = await supabase
    .from('trades')
    .select('*, accounts!inner(id, user_profile_id)')
    .gte('open_time', since)
    .order('open_time', { ascending: true });

  if (!recentTrades?.length) return results;

  const accountProfiles = new Map<string, string>();
  const tradesByAccount = new Map<string, any[]>();

  for (const trade of recentTrades) {
    const accountId = trade.account_id;
    accountProfiles.set(accountId, trade.accounts.user_profile_id);
    if (!tradesByAccount.has(accountId)) tradesByAccount.set(accountId, []);
    tradesByAccount.get(accountId)!.push(trade);
  }

  const accountIds = Array.from(tradesByAccount.keys());
  const checkedPairs = new Set<string>();

  for (let i = 0; i < accountIds.length; i++) {
    for (let j = i + 1; j < accountIds.length; j++) {
      const aId = accountIds[i];
      const bId = accountIds[j];

      if (accountProfiles.get(aId) === accountProfiles.get(bId)) continue;

      const pairKey = [aId, bId].sort().join(':');
      if (checkedPairs.has(pairKey)) continue;
      checkedPairs.add(pairKey);

      const resultAB = checkCopyDirection(tradesByAccount.get(aId)!, tradesByAccount.get(bId)!, aId, bId);
      const resultBA = checkCopyDirection(tradesByAccount.get(bId)!, tradesByAccount.get(aId)!, bId, aId);

      const best = resultAB.score >= resultBA.score ? resultAB : resultBA;
      if (best.score >= COPY_TRADING_CONFIG.score_threshold && best.matches.length >= COPY_TRADING_CONFIG.min_copied_trades) {
        results.push({
          violated: true,
          leader_account_id: best.leaderId,
          follower_account_id: best.followerId,
          score: best.score,
          matched_trades: best.matches,
          related_trade_ids: [
            ...best.matches.map(m => m.leader_trade_id),
            ...best.matches.map(m => m.follower_trade_id),
          ],
          details: {
            match_count: best.matches.length,
            avg_lag_seconds: best.avgLag,
            avg_lot_diff: best.avgLotDiff,
            consistency_score: best.consistencyScore,
            leader_profile: accountProfiles.get(best.leaderId),
            follower_profile: accountProfiles.get(best.followerId),
          },
        });
      }
    }
  }

  return results;
}

function checkCopyDirection(
  leaderTrades: any[],
  followerTrades: any[],
  leaderId: string,
  followerId: string
): {
  leaderId: string;
  followerId: string;
  score: number;
  matches: CopyTradeMatch[];
  avgLag: number;
  avgLotDiff: number;
  consistencyScore: number;
} {
  const matches: CopyTradeMatch[] = [];
  const usedFollower = new Set<string>();

  for (const lT of leaderTrades) {
    const leaderTime = new Date(lT.open_time).getTime();

    for (const fT of followerTrades) {
      if (usedFollower.has(fT.id)) continue;
      if (lT.symbol !== fT.symbol) continue;
      if (lT.direction !== fT.direction) continue;

      const followerTime = new Date(fT.open_time).getTime();
      const lag = (followerTime - leaderTime) / 1000;

      if (lag < 0 || lag > COPY_TRADING_CONFIG.lag_window_seconds) continue;

      const lotDiff = Math.abs(lT.lot_size - fT.lot_size) / Math.max(lT.lot_size, fT.lot_size);
      if (lotDiff > COPY_TRADING_CONFIG.lot_size_tolerance) continue;

      const priceDiff = Math.abs(lT.open_price - fT.open_price);

      matches.push({
        leader_trade_id: lT.id,
        follower_trade_id: fT.id,
        symbol: lT.symbol,
        lag_seconds: lag,
        lot_size_diff_pct: lotDiff,
        price_diff: priceDiff,
      });
      usedFollower.add(fT.id);
      break;
    }
  }

  if (matches.length === 0) {
    return { leaderId, followerId, score: 0, matches: [], avgLag: 0, avgLotDiff: 0, consistencyScore: 0 };
  }

  const avgLag = matches.reduce((s, m) => s + m.lag_seconds, 0) / matches.length;
  const avgLotDiff = matches.reduce((s, m) => s + m.lot_size_diff_pct, 0) / matches.length;

  const lagVariance = matches.reduce((s, m) => s + Math.pow(m.lag_seconds - avgLag, 2), 0) / matches.length;
  const lagStdDev = Math.sqrt(lagVariance);
  const consistencyScore = 1 - Math.min(lagStdDev / COPY_TRADING_CONFIG.lag_window_seconds, 1);

  const frequencyScore = Math.min(matches.length / 10, 1);
  const lagScore = 1 - Math.min(avgLag / COPY_TRADING_CONFIG.lag_window_seconds, 1);
  const lotScore = 1 - avgLotDiff;

  const score = frequencyScore * 0.3 + lagScore * 0.25 + lotScore * 0.2 + consistencyScore * 0.25;

  return { leaderId, followerId, score, matches, avgLag, avgLotDiff, consistencyScore };
}
