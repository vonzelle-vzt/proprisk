import { VIOLATION_LABELS, severityFromDeduction } from '@/lib/providers/types';

/**
 * Passed-challenge demo dataset. The challenge segment (risk dashboard +
 * violations/deductions "Challenges" tab) is forex-style evaluation accounts
 * that have fully passed and are analyzed for trade-level violations.
 *
 * The base shape mirrors `CachedChallengeAccount` (snake_case) used by the
 * analysis/violations/deductions routes; the dashboard list derives a
 * `PassedChallengeAccount` (camelCase) from it in the builders.
 */

export interface MockChallengeAccount {
  account_id: string;
  login: string;
  userId: number;
  email: string;
  first_name: string;
  last_name: string;
  country: string;
  plan: string;
  plan_type: string;
  type: number; // 1 = 1-step, 2 = 2-step (multi-phase)
  phase: number;
  phase_label: string;
  starting_balance: number;
  balance: number;
  equity: number;
  total_deductions: number;
  violation_count: number;
  violation_types: string[];
  violation_labels: string[];
  deduction_breakdown: Record<string, number>;
  severity: string;
  flagged_trade_count: number;
  ban_news_trading: boolean;
  ban_hft: boolean;
  ban_mtgl: boolean;
  traded_days: number;
  has_news_addon: boolean;
  added_at: string;
  pass_date: string;
  processed_at: string;
}

const FIRST = ['Adam', 'Beatriz', 'Chen', 'Dia', 'Emre', 'Farah', 'Gabriel', 'Hana', 'Igor', 'Jana', 'Karan', 'Lena', 'Mads', 'Nora', 'Oscar', 'Petra', 'Quinn', 'Rosa', 'Sami', 'Tara', 'Umar', 'Vera', 'Win', 'Xena', 'Yara', 'Zane', 'Ade', 'Bea'];
const LAST = ['Klein', 'Lima', 'Yu', 'Roy', 'Demir', 'Nasser', 'Santos', 'Mori', 'Petrov', 'Kovac', 'Mehta', 'Berg', 'Holm', 'Vidal', 'Ruiz', 'Novak', 'Walsh', 'Diaz', 'Haq', 'Singh', 'Aziz', 'Sokol', 'Tan', 'Cole', 'Saab', 'Lund', 'Bello', 'Costa'];
const COUNTRIES = ['United States', 'United Kingdom', 'India', 'Brazil', 'Germany', 'Nigeria', 'UAE', 'Japan', 'Spain', 'Canada', 'Vietnam', 'Mexico', 'Egypt', 'Australia', 'France'];
const PLATFORMS = ['MT5', 'MT4', 'cTrader'];
const VTYPES = ['overleveraging', 'hft', 'martingale', 'news', 'grid', 'copy'];

function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function build(): MockChallengeAccount[] {
  const rand = rng(20260702);
  const out: MockChallengeAccount[] = [];
  const SIZES = [10000, 25000, 50000, 100000, 200000];
  for (let i = 0; i < 28; i++) {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 3) % LAST.length];
    const size = SIZES[Math.floor(rand() * SIZES.length)];
    const platform = PLATFORMS[Math.floor(rand() * PLATFORMS.length)];
    const type = rand() < 0.5 ? 2 : 1; // 2-step or 1-step
    const stepLabel = type === 2 ? '2 Step' : '1 Step';
    const plan = `${platform} - ${size / 1000}K - ${stepLabel}`;
    const pnlPct = rand() * 0.14 + 0.06; // passed → 6–20% profit
    const balance = Math.round(size * (1 + pnlPct));

    // ~55% of analyzed passed challenges carry violations
    const deduction_breakdown: Record<string, number> = {};
    if (rand() < 0.55) {
      const n = 1 + Math.floor(rand() * 2);
      for (let k = 0; k < n; k++) {
        const t = VTYPES[Math.floor(rand() * VTYPES.length)];
        deduction_breakdown[t] = (deduction_breakdown[t] || 0) + Math.round(rand() * 500 + 40);
      }
    }
    const violation_types = Object.keys(deduction_breakdown);
    const total_deductions = Object.values(deduction_breakdown).reduce((s, v) => s + v, 0);

    out.push({
      account_id: `${800000 + i * 31}`,
      login: `${950000 + i * 97}`,
      userId: 600000 + i,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
      first_name: first,
      last_name: last,
      country: COUNTRIES[(i * 5) % COUNTRIES.length],
      plan,
      plan_type: stepLabel,
      type,
      phase: type === 2 ? 2 : 1,
      phase_label: type === 2 ? 'Phase 2' : 'Phase 1',
      starting_balance: size,
      balance,
      equity: balance,
      total_deductions,
      violation_count: violation_types.length,
      violation_types,
      violation_labels: violation_types.map((t) => (VIOLATION_LABELS as Record<string, string>)[t] || t),
      deduction_breakdown,
      severity: severityFromDeduction(total_deductions),
      flagged_trade_count: violation_types.length,
      ban_news_trading: rand() < 0.2,
      ban_hft: rand() < 0.15,
      ban_mtgl: rand() < 0.1,
      traded_days: 5 + Math.floor(rand() * 20),
      has_news_addon: rand() < 0.3,
      added_at: '',
      pass_date: '',
      processed_at: '',
    });
  }
  return out;
}

export const CHALLENGE_ACCOUNTS: MockChallengeAccount[] = build();
