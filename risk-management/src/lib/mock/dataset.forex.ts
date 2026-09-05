import type { ProviderId } from '@/lib/providers/types';

/**
 * Coherent FOREX demo dataset. The same accounts/logins are referenced across
 * every page (dashboard, payouts, violations, deductions, history, enforcement,
 * reviewer, emails) so the demo feels like one real book of business.
 *
 * Spread across the forex provider adapters so the "Trading Platform" provider
 * chips show multi-platform coverage.
 */

export interface MockAccount {
  provider: ProviderId;
  accountId: string;
  login: string;
  firstName: string;
  lastName: string;
  email: string;
  country: string;
  kycStatus: string; // 'Verified' | 'Pending' | 'Unverified'
  isBlackListed: boolean;
  plan: string; // parseable by parsePlanName
  startingBalance: number;
  balance: number;
  totalPnL: number;
  payoutAmount: number;
  tradedDays: number;
  /** violationType -> deduction amount (0 entries omitted) */
  deductionBreakdown: Record<string, number>;
  banNewsTrading?: boolean;
  banHFT?: boolean;
  banMTGL?: boolean;
  /** futures-only fields (unused for forex) */
  canTrade?: boolean;
  maxDailyLossPct?: number;
  maxTrailingDrawdownPct?: number;
  maxPositionSize?: number;
}

const FOREX_PROVIDERS: ProviderId[] = [
  'matchtrader',
  'dxtrade',
  'tradelocker',
  'ctrader',
  'metatrader',
];

const FIRST = ['James', 'Maria', 'Wei', 'Aditya', 'Sofia', 'Liam', 'Fatima', 'Diego', 'Noah', 'Yuki', 'Omar', 'Elena', 'Lucas', 'Priya', 'Tomas', 'Aisha', 'Daniel', 'Lin', 'Hassan', 'Mia', 'Carlos', 'Nadia', 'Ethan', 'Zara', 'Ivan', 'Grace', 'Mateo', 'Layla', 'Hugo', 'Sana'];
const LAST = ['Carter', 'Garcia', 'Chen', 'Sharma', 'Rossi', 'Murphy', 'Khan', 'Lopez', 'Smith', 'Tanaka', 'Haddad', 'Petrov', 'Silva', 'Patel', 'Novak', 'Ali', 'Brown', 'Wang', 'Saleh', 'Davies', 'Mendez', 'Karim', 'Walker', 'Hussain', 'Volkov', 'Bennett', 'Torres', 'Mansour', 'Dubois', 'Reddy'];
const COUNTRIES = ['United States', 'United Kingdom', 'India', 'Brazil', 'Germany', 'Nigeria', 'UAE', 'Japan', 'Spain', 'Canada', 'Vietnam', 'Mexico', 'Egypt', 'Australia', 'France'];
const PLANS = [
  'MT5 - 25K - 2 Step',
  'MT5 - 50K - 2 Step',
  'MT5 - 100K - 2 Step',
  'MT4 - 50K - 1 Step',
  'MT4 - 100K - 1 Step',
  'cTrader - 200K - 2 Step',
  'MT5 - 10K - 2 Step',
  'MT5 - 300K - 2 Step',
];
const VTYPES = ['overleveraging', 'hft', 'martingale', 'news', 'grid', 'copy'];

// Deterministic pseudo-random so the demo is stable across reloads/SSR.
function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function buildForexAccounts(): MockAccount[] {
  const rand = rng(20260630);
  const out: MockAccount[] = [];
  const SIZES = [10000, 25000, 50000, 100000, 200000, 300000];
  for (let i = 0; i < 32; i++) {
    const provider = FOREX_PROVIDERS[i % FOREX_PROVIDERS.length];
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    const size = SIZES[Math.floor(rand() * SIZES.length)];
    const plan = PLANS[Math.floor(rand() * PLANS.length)].replace(/\d+K/, `${size / 1000}K`);
    const pnlPct = rand() * 0.18 + 0.02; // 2%–20%
    const totalPnL = Math.round(size * pnlPct);
    const balance = size + totalPnL;
    const payoutAmount = Math.round(totalPnL * (rand() * 0.4 + 0.4)); // 40–80% of profit

    // ~45% of accounts have violations
    const deductionBreakdown: Record<string, number> = {};
    if (rand() < 0.45) {
      const n = 1 + Math.floor(rand() * 2);
      for (let k = 0; k < n; k++) {
        const t = VTYPES[Math.floor(rand() * VTYPES.length)];
        deductionBreakdown[t] = (deductionBreakdown[t] || 0) + Math.round((rand() * 600 + 40));
      }
    }

    out.push({
      provider,
      accountId: `${100000 + i * 37}`,
      login: `${500000 + i * 131}`,
      firstName: first,
      lastName: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
      country: COUNTRIES[(i * 3) % COUNTRIES.length],
      kycStatus: rand() < 0.8 ? 'Verified' : rand() < 0.5 ? 'Pending' : 'Unverified',
      isBlackListed: rand() < 0.06,
      plan,
      startingBalance: size,
      balance,
      totalPnL,
      payoutAmount,
      tradedDays: 5 + Math.floor(rand() * 25),
      deductionBreakdown,
      banNewsTrading: rand() < 0.2,
      banHFT: rand() < 0.15,
      banMTGL: rand() < 0.1,
    });
  }
  return out;
}

export const FOREX_ACCOUNTS: MockAccount[] = buildForexAccounts();
