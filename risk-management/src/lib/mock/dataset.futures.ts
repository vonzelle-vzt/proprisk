import type { ProviderId } from '@/lib/providers/types';
import type { MockAccount } from './dataset.forex';

/**
 * Coherent FUTURES demo dataset — the Futures side of the global toggle.
 * Uses futures concepts: contracts (not lots), instruments ES/NQ/CL/GC, prop
 * eval rules (trailing max drawdown, daily loss limit, position limit), and the
 * `canTrade` breach flag. Spread across the futures provider adapters.
 */

const FUTURES_PROVIDERS: ProviderId[] = [
  'tradovate',
  'rithmic',
  'topstepx',
  'cqg',
  'ninjatrader',
];

const FIRST = ['Ryan', 'Chloe', 'Marcus', 'Ana', 'Kenji', 'Bram', 'Tariq', 'Isabel', 'Cole', 'Hana', 'Pavel', 'Nina', 'Drew', 'Sami', 'Greg', 'Lara', 'Victor', 'Mei', 'Jamal', 'Eva', 'Trent', 'Rosa', 'Kyle', 'Dina'];
const LAST = ['Foster', 'Nguyen', 'Hill', 'Costa', 'Ito', 'Visser', 'Aziz', 'Romero', 'Ward', 'Kim', 'Sokolov', 'Berg', 'Cole', 'Haq', 'Olsen', 'Frost', 'Marin', 'Zhou', 'Idris', 'Lund', 'Boyd', 'Ramos', 'Reed', 'Said'];
const COUNTRIES = ['United States', 'Canada', 'United Kingdom', 'Australia', 'Germany', 'Singapore', 'Japan', 'Brazil', 'Netherlands', 'UAE'];
// Futures eval plans (Topstep/Apex-style)
const PLANS = [
  'Tradovate - 50K - Eval',
  'Rithmic - 100K - Funded',
  'TopstepX - 50K - Combine',
  'TopstepX - 150K - Combine',
  'CQG - 100K - Eval',
  'NinjaTrader - 50K - Funded',
  'Tradovate - 25K - Eval',
  'Rithmic - 150K - Funded',
];
// Futures violation taxonomy (computed by our futures engine)
const VTYPES = ['daily_loss', 'trailing_drawdown', 'position_limit', 'hft', 'copy'];

function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function buildFuturesAccounts(): MockAccount[] {
  const rand = rng(20260701);
  const out: MockAccount[] = [];
  const SIZES = [25000, 50000, 100000, 150000];
  for (let i = 0; i < 26; i++) {
    const provider = FUTURES_PROVIDERS[i % FUTURES_PROVIDERS.length];
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 5) % LAST.length];
    const size = SIZES[Math.floor(rand() * SIZES.length)];
    const plan = PLANS[Math.floor(rand() * PLANS.length)].replace(/\d+K/, `${size / 1000}K`);
    const pnlPct = rand() * 0.12 - 0.02; // -2%–10% (futures evals see more blowups)
    const totalPnL = Math.round(size * pnlPct);
    const balance = size + totalPnL;
    const payoutAmount = totalPnL > 0 ? Math.round(totalPnL * (rand() * 0.5 + 0.3)) : 0;

    // futures eval rules by size
    const maxDailyLossPct = 0.03 + rand() * 0.02; // 3–5%
    const maxTrailingDrawdownPct = 0.04 + rand() * 0.03; // 4–7%
    const maxPositionSize = size <= 50000 ? 5 : size <= 100000 ? 10 : 15; // contracts

    // ~50% have breaches; daily_loss/trailing_drawdown imply canTrade=false
    const deductionBreakdown: Record<string, number> = {};
    let canTrade = true;
    if (rand() < 0.5) {
      const n = 1 + Math.floor(rand() * 2);
      for (let k = 0; k < n; k++) {
        const t = VTYPES[Math.floor(rand() * VTYPES.length)];
        deductionBreakdown[t] = (deductionBreakdown[t] || 0) + Math.round(rand() * 800 + 60);
        if (t === 'daily_loss' || t === 'trailing_drawdown') canTrade = false;
      }
    }

    out.push({
      provider,
      accountId: `${700000 + i * 41}`,
      login: `${900000 + i * 113}`,
      firstName: first,
      lastName: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
      country: COUNTRIES[(i * 3) % COUNTRIES.length],
      kycStatus: rand() < 0.85 ? 'Verified' : 'Pending',
      isBlackListed: rand() < 0.05,
      plan,
      startingBalance: size,
      balance,
      totalPnL,
      payoutAmount,
      tradedDays: 3 + Math.floor(rand() * 20),
      deductionBreakdown,
      canTrade,
      maxDailyLossPct: Number(maxDailyLossPct.toFixed(3)),
      maxTrailingDrawdownPct: Number(maxTrailingDrawdownPct.toFixed(3)),
      maxPositionSize,
    });
  }
  return out;
}

export const FUTURES_ACCOUNTS: MockAccount[] = buildFuturesAccounts();
