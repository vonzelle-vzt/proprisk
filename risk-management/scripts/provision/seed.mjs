#!/usr/bin/env node
/**
 * Verify a freshly-provisioned client database and optionally load training data.
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/provision/seed.mjs [--demo-data]
 *
 * Default: read-only smoke test that every core table exists and is reachable
 * (i.e. supabase/migrations/*.sql were applied in order).
 *
 * --demo-data: inserts a small set of sample accounts + violations so the
 * client team has something to click through during onboarding/training.
 * Real violation thresholds live in code (src/config/violations.ts) — no
 * reference rows are required for the app to function.
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const demoData = process.argv.includes('--demo-data');

if (!url || !serviceKey) {
  console.error('Usage: NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node seed.mjs [--demo-data]');
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const CORE_TABLES = [
  'accounts', 'trades', 'violations', 'deductions', 'emails', 'audit_log',
  'news_events', 'violation_config', 'risk_profiles', 'risk_alerts',
  'payout_history', 'account_snapshots', 'fraud_investigations',
  'enforcement_queue', 'reviewer_runs',
];

let failed = 0;
for (const table of CORE_TABLES) {
  const { error } = await supabase.from(table).select('*', { count: 'exact', head: true });
  if (error) {
    console.error(`FAIL ${table}: ${error.message}`);
    failed++;
  } else {
    console.log(`OK   ${table}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} table(s) unreachable — apply supabase/migrations/*.sql (in order) first.`);
  process.exit(1);
}

if (demoData) {
  const sizes = [25000, 50000, 100000, 50000, 25000];
  const sampleAccounts = Array.from({ length: 5 }, (_, i) => ({
    login: `9100${i + 1}`,
    user_profile_id: `training-${i + 1}`,
    trader_name: `Training Trader ${i + 1}`,
    email: `training-${i + 1}@example.com`,
    challenge_type: ['pro', 'flex', '1_phase', 'pro', 'flex'][i],
    account_size: sizes[i],
    phase: 'funded',
    balance: sizes[i],
    equity: sizes[i],
    starting_day_balance: sizes[i],
    starting_day_equity: sizes[i],
    is_active: true,
  }));

  const { data: accounts, error } = await supabase
    .from('accounts')
    .upsert(sampleAccounts, { onConflict: 'login' })
    .select('id, login');

  if (error) {
    console.error(`FAIL demo accounts: ${error.message}`);
    process.exit(1);
  }
  console.log(`OK   inserted ${accounts.length} training accounts (logins 91001–91005)`);
}

console.log('\nSeed complete.');
