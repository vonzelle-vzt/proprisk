-- ============================================================
-- 00001 — consolidated pre-tenancy schema
-- ============================================================
--
-- The whole schema as it stood immediately before multi-tenancy: every enum,
-- table, index, constraint, function and trigger the platform accumulated over
-- its first fourteen migrations, flattened into one file a fresh database can
-- apply in a single pass.
--
-- TENANCY AND ROW-LEVEL SECURITY BEGIN AT 00015_tenancy.sql. Nothing in this
-- file is tenant-scoped. 00015 adds tenant_id to every table created here,
-- drops and rewrites every policy with a tenant predicate, and forces RLS. This
-- file on its own is not a secure schema and was never meant to be applied
-- without the migrations that follow it — apply the whole directory, in order.
--
-- Numbers 00002-00014 are intentionally unused. The migrations that held them
-- were folded into this file, and the gap is deliberate: it lets 00015_tenancy
-- keep the number it has carried since it was written, so that every reference
-- to "tenancy starts at 00015" — in scripts/check-isolation.mjs, in
-- supabase/tests/verify-isolation.sh, and in the docs — stays true. Do not fill
-- the gap. The next migration to be written is 00025.
--
-- The `-- source:` markers below record which historical migration each block
-- came from. Those files are no longer in the tree; the markers are kept so the
-- consolidation stays auditable block by block.
-- ============================================================


-- ============================================================
-- source: migrations/00001_initial_schema.sql
-- ============================================================
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- ENUM TYPES
-- ============================================================

CREATE TYPE violation_type AS ENUM (
  '2_percent_cap', 'overleveraging', 'hft', 'martingale', 'news', 'grid', 'copy'
);

CREATE TYPE challenge_type AS ENUM ('pro', 'flex', '1_phase');

CREATE TYPE account_phase AS ENUM ('challenge', 'verification', 'funded');

CREATE TYPE asset_class AS ENUM ('commodities_metals', 'indices', 'crypto', 'forex');

CREATE TYPE trade_direction AS ENUM ('buy', 'sell');

CREATE TYPE violation_status AS ENUM ('detected', 'confirmed', 'deducted', 'dismissed', 'under_review');

CREATE TYPE violation_severity AS ENUM ('low', 'medium', 'high', 'critical');

CREATE TYPE deduction_execution_type AS ENUM ('automatic', 'manual');

CREATE TYPE email_status AS ENUM ('sent', 'failed', 'pending');

CREATE TYPE news_impact_level AS ENUM ('red', 'orange', 'yellow');

CREATE TYPE news_source AS ENUM ('forex_factory', 'fxstreet');

-- ============================================================
-- ACCOUNTS TABLE
-- ============================================================

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  login VARCHAR(50) NOT NULL UNIQUE,
  user_profile_id VARCHAR(100) NOT NULL,
  account_size INTEGER NOT NULL CHECK (account_size IN (2500, 5000, 10000, 25000, 50000, 100000, 200000, 300000)),
  challenge_type challenge_type NOT NULL,
  phase account_phase NOT NULL,
  balance DECIMAL(15,2) NOT NULL DEFAULT 0,
  equity DECIMAL(15,2) NOT NULL DEFAULT 0,
  starting_day_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
  starting_day_equity DECIMAL(15,2) NOT NULL DEFAULT 0,
  email VARCHAR(255) NOT NULL,
  trader_name VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_accounts_login ON accounts(login);
CREATE INDEX idx_accounts_user_profile ON accounts(user_profile_id);
CREATE INDEX idx_accounts_phase ON accounts(phase);
CREATE INDEX idx_accounts_challenge_type ON accounts(challenge_type);
CREATE INDEX idx_accounts_size ON accounts(account_size);

-- ============================================================
-- TRADES TABLE
-- ============================================================

CREATE TABLE trades (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  trade_id_external VARCHAR(100) NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  asset_class asset_class NOT NULL,
  direction trade_direction NOT NULL,
  lot_size DECIMAL(10,4) NOT NULL,
  open_price DECIMAL(15,5) NOT NULL,
  close_price DECIMAL(15,5),
  open_time TIMESTAMPTZ NOT NULL,
  close_time TIMESTAMPTZ,
  profit DECIMAL(15,2) NOT NULL DEFAULT 0,
  swap DECIMAL(10,2) NOT NULL DEFAULT 0,
  commission DECIMAL(10,2) NOT NULL DEFAULT 0,
  comment TEXT,
  magic_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_trades_external ON trades(account_id, trade_id_external);
CREATE INDEX idx_trades_account ON trades(account_id);
CREATE INDEX idx_trades_symbol ON trades(symbol);
CREATE INDEX idx_trades_open_time ON trades(open_time);
CREATE INDEX idx_trades_close_time ON trades(close_time);
CREATE INDEX idx_trades_account_open_time ON trades(account_id, open_time);
CREATE INDEX idx_trades_account_close_time ON trades(account_id, close_time);

-- ============================================================
-- VIOLATIONS TABLE
-- ============================================================

CREATE TABLE violations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  violation_type violation_type NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status violation_status NOT NULL DEFAULT 'detected',
  severity violation_severity NOT NULL DEFAULT 'medium',
  details_json JSONB NOT NULL DEFAULT '{}',
  related_trade_ids UUID[] NOT NULL DEFAULT '{}',
  deduction_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  phase account_phase NOT NULL,
  challenge_type challenge_type NOT NULL,
  account_size INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_violations_account ON violations(account_id);
CREATE INDEX idx_violations_type ON violations(violation_type);
CREATE INDEX idx_violations_status ON violations(status);
CREATE INDEX idx_violations_detected ON violations(detected_at);
CREATE INDEX idx_violations_account_type ON violations(account_id, violation_type);
CREATE INDEX idx_violations_type_detected ON violations(violation_type, detected_at);

-- ============================================================
-- DEDUCTIONS TABLE
-- ============================================================

CREATE TABLE deductions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  violation_id UUID REFERENCES violations(id) ON DELETE SET NULL,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount DECIMAL(15,2) NOT NULL,
  pre_balance DECIMAL(15,2) NOT NULL,
  post_balance DECIMAL(15,2) NOT NULL,
  executed_by VARCHAR(255) NOT NULL DEFAULT 'system',
  execution_type deduction_execution_type NOT NULL DEFAULT 'automatic',
  reason TEXT NOT NULL,
  approved_by VARCHAR(255),
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deductions_account ON deductions(account_id);
CREATE INDEX idx_deductions_violation ON deductions(violation_id);
CREATE INDEX idx_deductions_executed ON deductions(executed_at);
CREATE INDEX idx_deductions_type ON deductions(execution_type);

-- ============================================================
-- EMAILS TABLE
-- ============================================================

CREATE TABLE emails (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  violation_id UUID REFERENCES violations(id) ON DELETE SET NULL,
  deduction_id UUID REFERENCES deductions(id) ON DELETE SET NULL,
  recipient VARCHAR(255) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  body TEXT NOT NULL,
  template_type VARCHAR(50) NOT NULL,
  sent_by VARCHAR(255) NOT NULL DEFAULT 'system',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sendgrid_message_id VARCHAR(255),
  status email_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_emails_account ON emails(account_id);
CREATE INDEX idx_emails_violation ON emails(violation_id);
CREATE INDEX idx_emails_deduction ON emails(deduction_id);
CREATE INDEX idx_emails_sent ON emails(sent_at);

-- ============================================================
-- AUDIT LOG TABLE (append-only)
-- ============================================================

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  action_type VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(255) NOT NULL,
  performed_by VARCHAR(255) NOT NULL DEFAULT 'system',
  details_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_action ON audit_log(action_type);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- ============================================================
-- NEWS EVENTS TABLE
-- ============================================================

CREATE TABLE news_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_name VARCHAR(500) NOT NULL,
  currency VARCHAR(10) NOT NULL,
  impact_level news_impact_level NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  source news_source NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_news_scheduled ON news_events(scheduled_at);
CREATE INDEX idx_news_currency ON news_events(currency);
CREATE INDEX idx_news_impact ON news_events(impact_level);
CREATE UNIQUE INDEX idx_news_unique ON news_events(event_name, currency, scheduled_at, source);

-- ============================================================
-- VIOLATION CONFIG TABLE
-- ============================================================

CREATE TABLE violation_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  violation_type violation_type NOT NULL,
  config_key VARCHAR(100) NOT NULL,
  config_value TEXT NOT NULL,
  challenge_type challenge_type,
  account_size INTEGER,
  phase account_phase,
  active BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vconfig_type ON violation_config(violation_type);
CREATE INDEX idx_vconfig_active ON violation_config(active);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE violations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE news_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE violation_config ENABLE ROW LEVEL SECURITY;

-- Authenticated users (risk team) can read all data
CREATE POLICY "Risk team read accounts" ON accounts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Risk team read trades" ON trades FOR SELECT TO authenticated USING (true);
CREATE POLICY "Risk team read violations" ON violations FOR SELECT TO authenticated USING (true);
CREATE POLICY "Risk team read deductions" ON deductions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Risk team read emails" ON emails FOR SELECT TO authenticated USING (true);
CREATE POLICY "Risk team read audit_log" ON audit_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "Risk team read news_events" ON news_events FOR SELECT TO authenticated USING (true);
CREATE POLICY "Risk team read violation_config" ON violation_config FOR SELECT TO authenticated USING (true);

-- Service role (API routes) can do everything - handled by service_role key bypassing RLS

-- ============================================================
-- UPDATED_AT TRIGGER FUNCTION
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_accounts_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_vconfig_updated_at
  BEFORE UPDATE ON violation_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- source: migrations/00002_audit_hash_chain.sql
-- ============================================================
-- Add tamper-evident chain fields to audit log
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS prev_hash TEXT,
  ADD COLUMN IF NOT EXISTS entry_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_entry_hash ON audit_log(entry_hash);

-- Enforce append-only behavior in the database layer
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only; % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_audit_log_update ON audit_log;
CREATE TRIGGER trg_prevent_audit_log_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_mutation();

DROP TRIGGER IF EXISTS trg_prevent_audit_log_delete ON audit_log;
CREATE TRIGGER trg_prevent_audit_log_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_mutation();

-- ============================================================
-- source: migrations/00003_risk_engine_tables.sql
-- ============================================================
-- ============================================================
-- RISK ENGINE TABLES (NO-AUTH-FIRST MVP)
-- ============================================================

CREATE TABLE IF NOT EXISTS risk_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('draft', 'active', 'archived')) DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  rules_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_profiles_account ON risk_profiles(account_id);
CREATE INDEX IF NOT EXISTS idx_risk_profiles_status ON risk_profiles(status);
CREATE INDEX IF NOT EXISTS idx_risk_profiles_account_status ON risk_profiles(account_id, status);

CREATE TABLE IF NOT EXISTS risk_pretrade_decisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES risk_profiles(id) ON DELETE CASCADE,
  result VARCHAR(10) NOT NULL CHECK (result IN ('pass', 'warn', 'block')),
  risk_amount DECIMAL(18,6) NOT NULL,
  risk_percent DECIMAL(10,6) NOT NULL,
  violations_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  suggestions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  request_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_decisions_account_created ON risk_pretrade_decisions(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_decisions_result ON risk_pretrade_decisions(result);

CREATE TABLE IF NOT EXISTS risk_trade_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_type VARCHAR(120) NOT NULL,
  symbol VARCHAR(30),
  pnl_delta DECIMAL(15,2),
  exposure_value DECIMAL(18,4),
  quantity DECIMAL(18,4),
  price DECIMAL(18,6),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  idempotency_key VARCHAR(200) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_risk_events_account_occurred ON risk_trade_events(account_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS risk_violations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_event_id UUID REFERENCES risk_trade_events(id) ON DELETE SET NULL,
  violation_type VARCHAR(100) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status VARCHAR(20) NOT NULL CHECK (status IN ('open', 'monitoring', 'closed')) DEFAULT 'open',
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_violations_account_created ON risk_violations(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_violations_status ON risk_violations(status);

CREATE TABLE IF NOT EXISTS risk_alerts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  violation_id UUID NOT NULL REFERENCES risk_violations(id) ON DELETE CASCADE,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status VARCHAR(20) NOT NULL CHECK (status IN ('new', 'acknowledged', 'resolved')) DEFAULT 'new',
  title VARCHAR(240) NOT NULL,
  message TEXT NOT NULL,
  dedupe_key VARCHAR(200) NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_risk_alerts_account_created ON risk_alerts(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_alerts_status ON risk_alerts(status);
CREATE INDEX IF NOT EXISTS idx_risk_alerts_severity_status ON risk_alerts(severity, status);

CREATE TABLE IF NOT EXISTS risk_session_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('generating', 'ready', 'partial_data', 'failed')) DEFAULT 'ready',
  metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, session_date)
);

CREATE INDEX IF NOT EXISTS idx_risk_reports_account_date ON risk_session_reports(account_id, session_date DESC);

ALTER TABLE risk_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_pretrade_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_trade_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_violations ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_session_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Risk team read risk_profiles" ON risk_profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Risk team read risk_pretrade_decisions" ON risk_pretrade_decisions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Risk team read risk_trade_events" ON risk_trade_events FOR SELECT TO authenticated USING (true);
CREATE POLICY "Risk team read risk_violations" ON risk_violations FOR SELECT TO authenticated USING (true);
CREATE POLICY "Risk team read risk_alerts" ON risk_alerts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Risk team read risk_session_reports" ON risk_session_reports FOR SELECT TO authenticated USING (true);

CREATE TRIGGER set_risk_profiles_updated_at
  BEFORE UPDATE ON risk_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- source: migrations/00004_payout_history.sql
-- ============================================================
-- Payout History / Track Record table
-- Stores full snapshots of enriched payout records at decision time
-- so that approved/rejected payouts are never lost when they leave the trading platform's pending queue.

CREATE TABLE IF NOT EXISTS payout_history (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  platform_payout_id TEXT NOT NULL,
  platform_account_id TEXT NOT NULL,
  platform_order_id TEXT,
  login           TEXT,
  email           TEXT,
  first_name      TEXT,
  last_name       TEXT,
  country         TEXT,
  plan            TEXT,

  -- Payout amounts
  amount          NUMERIC(14,2),
  client_amount   NUMERIC(14,2),
  fee             NUMERIC(14,2),
  profit_share_pct NUMERIC(5,2),
  method          TEXT,
  balance         NUMERIC(14,2),
  starting_balance NUMERIC(14,2),

  -- Account metrics
  traded_days     INT,
  total_pnl       NUMERIC(14,2),

  -- KYC / risk
  kyc_status      TEXT,
  kyc_verified    BOOLEAN DEFAULT FALSE,
  is_blacklisted  BOOLEAN DEFAULT FALSE,
  pre_approved_status INT DEFAULT 0,

  -- Violations & deductions at decision time
  violations_list TEXT[] DEFAULT '{}',
  deductions_total NUMERIC(14,2) DEFAULT 0,
  deductions_violation_count INT DEFAULT 0,
  deductions_by_type JSONB DEFAULT '{}',

  -- Decision
  decision        TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decided_by      TEXT,
  decided_at      TIMESTAMPTZ DEFAULT NOW(),
  decision_notes  TEXT,

  -- Full enriched snapshot (PayoutRecord JSON)
  full_snapshot   JSONB,

  created_at      TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_payout_decision UNIQUE (platform_payout_id, decision)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_payout_history_login ON payout_history (login);
CREATE INDEX IF NOT EXISTS idx_payout_history_email ON payout_history (email);
CREATE INDEX IF NOT EXISTS idx_payout_history_decision ON payout_history (decision);
CREATE INDEX IF NOT EXISTS idx_payout_history_decided_at ON payout_history (decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_payout_history_account ON payout_history (platform_account_id);
CREATE INDEX IF NOT EXISTS idx_payout_history_composite ON payout_history (decision, decided_at DESC);

-- RLS
ALTER TABLE payout_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read payout history"
  ON payout_history
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can insert payout history"
  ON payout_history
  FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "Service role can update payout history"
  ON payout_history
  FOR UPDATE
  TO service_role
  USING (true);

-- ============================================================
-- source: migrations/00005_payout_history_columns.sql
-- ============================================================
-- Add missing columns to payout_history that snapshot.ts writes to
-- and expand decision constraint to include 'pending' for auto-snapshots

-- Identity columns
ALTER TABLE payout_history ADD COLUMN IF NOT EXISTS customer_id TEXT;
ALTER TABLE payout_history ADD COLUMN IF NOT EXISTS user_id TEXT;

-- Payout details
ALTER TABLE payout_history ADD COLUMN IF NOT EXISTS date_requested TEXT;
ALTER TABLE payout_history ADD COLUMN IF NOT EXISTS max_daily_profit NUMERIC(14,2);
ALTER TABLE payout_history ADD COLUMN IF NOT EXISTS num_approved_payouts INT;
ALTER TABLE payout_history ADD COLUMN IF NOT EXISTS approved_payouts_total NUMERIC(14,2);
ALTER TABLE payout_history ADD COLUMN IF NOT EXISTS balance_at_request NUMERIC(14,2);

-- Ban flags
ALTER TABLE payout_history ADD COLUMN IF NOT EXISTS ban_news_trading BOOLEAN DEFAULT FALSE;
ALTER TABLE payout_history ADD COLUMN IF NOT EXISTS ban_hft BOOLEAN DEFAULT FALSE;
ALTER TABLE payout_history ADD COLUMN IF NOT EXISTS ban_mtgl BOOLEAN DEFAULT FALSE;

-- Pre-approval
ALTER TABLE payout_history ADD COLUMN IF NOT EXISTS pre_approved_by TEXT;

-- Deduction percentages
ALTER TABLE payout_history ADD COLUMN IF NOT EXISTS deductions_pct_starting_balance NUMERIC(8,4) DEFAULT 0;
ALTER TABLE payout_history ADD COLUMN IF NOT EXISTS deductions_pct_total_pl NUMERIC(8,4) DEFAULT 0;

-- Allow 'pending' as a decision type for auto-snapshots of pending payouts
ALTER TABLE payout_history DROP CONSTRAINT IF EXISTS payout_history_decision_check;
ALTER TABLE payout_history ADD CONSTRAINT payout_history_decision_check
  CHECK (decision IN ('approved', 'rejected', 'pending'));

-- Index for pending snapshot lookups
CREATE INDEX IF NOT EXISTS idx_payout_history_pending
  ON payout_history (platform_payout_id)
  WHERE decision = 'pending';

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- source: migrations/00005_challenge_violation_cache.sql
-- ============================================================
-- Challenge violation cache: stores analyzed violation data for challenge accounts
-- Progressive sync fills this table in batches of 1000

CREATE TABLE IF NOT EXISTS challenge_violation_cache (
  account_id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  email TEXT DEFAULT '',
  first_name TEXT DEFAULT '',
  last_name TEXT DEFAULT '',
  country TEXT DEFAULT '',
  plan TEXT DEFAULT '',
  plan_type TEXT DEFAULT '',
  phase INTEGER NOT NULL,
  phase_label TEXT NOT NULL,
  starting_balance NUMERIC DEFAULT 0,
  balance NUMERIC DEFAULT 0,
  equity NUMERIC DEFAULT 0,
  total_deductions NUMERIC DEFAULT 0,
  violation_count INTEGER DEFAULT 0,
  violation_types TEXT[] DEFAULT '{}',
  violation_labels TEXT[] DEFAULT '{}',
  deduction_breakdown JSONB DEFAULT '{}',
  severity TEXT DEFAULT 'low' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  flagged_trade_count INTEGER DEFAULT 0,
  ban_news_trading BOOLEAN DEFAULT FALSE,
  ban_hft BOOLEAN DEFAULT FALSE,
  ban_mtgl BOOLEAN DEFAULT FALSE,
  traded_days INTEGER DEFAULT 0,
  has_news_addon BOOLEAN DEFAULT FALSE,
  added_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_challenge_cache_phase ON challenge_violation_cache (phase);
CREATE INDEX idx_challenge_cache_severity ON challenge_violation_cache (severity);
CREATE INDEX idx_challenge_cache_deductions ON challenge_violation_cache (total_deductions DESC);
CREATE INDEX idx_challenge_cache_processed ON challenge_violation_cache (processed_at);
CREATE INDEX idx_challenge_cache_login ON challenge_violation_cache (login);

-- Track sync progress: which skip offset we've processed up to
CREATE TABLE IF NOT EXISTS challenge_sync_progress (
  id TEXT PRIMARY KEY DEFAULT 'default',
  last_skip INTEGER DEFAULT 0,
  total_api_accounts INTEGER DEFAULT 0,
  total_cached INTEGER DEFAULT 0,
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  is_complete BOOLEAN DEFAULT FALSE
);

INSERT INTO challenge_sync_progress (id) VALUES ('default') ON CONFLICT DO NOTHING;

ALTER TABLE challenge_violation_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenge_sync_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access to challenge_violation_cache"
  ON challenge_violation_cache FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service role full access to challenge_sync_progress"
  ON challenge_sync_progress FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- source: migrations/00006_add_trades_to_cache.sql
-- ============================================================
-- Add trades column to challenge_violation_cache for storing per-account trade data
ALTER TABLE challenge_violation_cache ADD COLUMN IF NOT EXISTS trades JSONB DEFAULT '[]';

-- Add pass_date column
ALTER TABLE challenge_violation_cache ADD COLUMN IF NOT EXISTS pass_date TIMESTAMPTZ;

-- Add violation_details column for per-trade violation breakdowns
ALTER TABLE challenge_violation_cache ADD COLUMN IF NOT EXISTS violation_details JSONB DEFAULT '{}';

-- ============================================================
-- source: migrations/00007_add_news_events_to_cache.sql
-- ============================================================
-- Add news_events column to challenge_violation_cache
-- This was missing, causing the entire upsert to silently fail
-- when analyzeAccount() included news_events in the object.
ALTER TABLE challenge_violation_cache ADD COLUMN IF NOT EXISTS news_events JSONB DEFAULT '[]';

-- ============================================================
-- source: migrations/00006_account_snapshots.sql
-- ============================================================
-- Account snapshots: persist the trading platform account + user data so it's not lost
-- Updated each time we enrich a payout or view an account

CREATE TABLE IF NOT EXISTS account_snapshots (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  platform_account_id   TEXT NOT NULL,
  login               TEXT,
  email               TEXT,
  first_name          TEXT,
  last_name           TEXT,
  country             TEXT,
  kyc_status          TEXT,
  kyc_verified        BOOLEAN DEFAULT FALSE,
  is_blacklisted      BOOLEAN DEFAULT FALSE,

  -- Plan & balance
  plan                TEXT,
  starting_balance    NUMERIC(14,2),
  balance             NUMERIC(14,2),
  equity              NUMERIC(14,2),
  total_pnl           NUMERIC(14,2),

  -- Metrics
  traded_days         INT,
  max_daily_profit    NUMERIC(14,2),
  num_approved_payouts INT,
  approved_payouts_total NUMERIC(14,2),

  -- Bans
  ban_news_trading    BOOLEAN DEFAULT FALSE,
  ban_hft             BOOLEAN DEFAULT FALSE,
  ban_mtgl            BOOLEAN DEFAULT FALSE,

  -- Violations snapshot
  deductions_total    NUMERIC(14,2) DEFAULT 0,
  deductions_by_type  JSONB DEFAULT '{}',
  violation_count     INT DEFAULT 0,

  -- Full raw API response for forensics
  raw_account_data    JSONB,
  raw_user_data       JSONB,

  -- Timestamps
  snapshot_at         TIMESTAMPTZ DEFAULT NOW(),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_account_snapshot UNIQUE (platform_account_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_account_snapshots_login ON account_snapshots (login);
CREATE INDEX IF NOT EXISTS idx_account_snapshots_email ON account_snapshots (email);
CREATE INDEX IF NOT EXISTS idx_account_snapshots_updated ON account_snapshots (updated_at DESC);

-- RLS
ALTER TABLE account_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read account snapshots"
  ON account_snapshots FOR SELECT TO authenticated USING (true);

CREATE POLICY "Service role can manage account snapshots"
  ON account_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Notify PostgREST
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- source: migrations/00008_fraud_investigations.sql
-- ============================================================
-- Fraud Hunter agent: cross-account fraud investigation tracking
CREATE TABLE IF NOT EXISTS fraud_investigations (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fraud_type        TEXT NOT NULL CHECK (fraud_type IN (
    'copy_ring', 'shared_identity', 'coordinated_payout',
    'account_churning', 'profit_manipulation'
  )),
  severity          TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status            TEXT NOT NULL CHECK (status IN (
    'open', 'reviewing', 'confirmed', 'dismissed', 'actioned'
  )) DEFAULT 'open',
  confidence_score  NUMERIC(5,2) NOT NULL,
  account_ids       TEXT[] NOT NULL,
  user_ids          TEXT[] DEFAULT '{}',
  primary_account   TEXT,
  title             TEXT NOT NULL,
  summary           TEXT NOT NULL,
  evidence          JSONB NOT NULL DEFAULT '{}',
  total_amount_at_risk NUMERIC(14,2) DEFAULT 0,
  recommended_action TEXT,
  resolved_by       TEXT,
  resolved_at       TIMESTAMPTZ,
  resolution_notes  TEXT,
  dedupe_key        TEXT NOT NULL,
  detected_at       TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_fraud_dedupe UNIQUE (dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_fraud_inv_type ON fraud_investigations (fraud_type);
CREATE INDEX IF NOT EXISTS idx_fraud_inv_status ON fraud_investigations (status);
CREATE INDEX IF NOT EXISTS idx_fraud_inv_severity ON fraud_investigations (severity, status);
CREATE INDEX IF NOT EXISTS idx_fraud_inv_detected ON fraud_investigations (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_inv_accounts ON fraud_investigations USING GIN (account_ids);

ALTER TABLE fraud_investigations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read fraud_investigations"
  ON fraud_investigations FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role can manage fraud_investigations"
  ON fraud_investigations FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- source: migrations/00009_enforcement_queue.sql
-- ============================================================
-- Violation Enforcer agent: enforcement queue and repeat offender tracking

CREATE TABLE IF NOT EXISTS enforcement_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id VARCHAR(100) NOT NULL,
  violation_id UUID,
  violation_type TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'deduction', 'payout_hold', 'account_restriction', 'escalation', 'warning'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'approved', 'rejected', 'executed', 'expired', 'auto_escalated'
  )) DEFAULT 'pending',
  severity_score INTEGER NOT NULL DEFAULT 0 CHECK (severity_score >= 0 AND severity_score <= 100),
  escalation_level TEXT NOT NULL CHECK (escalation_level IN (
    'normal', 'elevated', 'urgent', 'critical'
  )) DEFAULT 'normal',
  recommended_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  recommendation_reason TEXT NOT NULL,
  recommendation_details JSONB NOT NULL DEFAULT '{}',
  prior_violation_count INTEGER NOT NULL DEFAULT 0,
  repeat_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1.0,
  decided_by VARCHAR(255),
  decided_at TIMESTAMPTZ,
  decision_notes TEXT,
  executed_at TIMESTAMPTZ,
  execution_result JSONB,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eq_account ON enforcement_queue(account_id);
CREATE INDEX IF NOT EXISTS idx_eq_status ON enforcement_queue(status);
CREATE INDEX IF NOT EXISTS idx_eq_severity ON enforcement_queue(severity_score DESC);
CREATE INDEX IF NOT EXISTS idx_eq_escalation ON enforcement_queue(escalation_level);
CREATE INDEX IF NOT EXISTS idx_eq_created ON enforcement_queue(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eq_expires ON enforcement_queue(expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_eq_violation_type ON enforcement_queue(violation_type);
CREATE INDEX IF NOT EXISTS idx_eq_account_status ON enforcement_queue(account_id, status);

CREATE TABLE IF NOT EXISTS account_violation_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id VARCHAR(100) NOT NULL,
  violation_type TEXT NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  last_violation_at TIMESTAMPTZ,
  total_deduction_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  escalation_tier INTEGER NOT NULL DEFAULT 0,
  count_last_24h INTEGER NOT NULL DEFAULT 0,
  count_last_7d INTEGER NOT NULL DEFAULT 0,
  count_last_30d INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, violation_type)
);

CREATE INDEX IF NOT EXISTS idx_avh_account ON account_violation_history(account_id);
CREATE INDEX IF NOT EXISTS idx_avh_type ON account_violation_history(violation_type);
CREATE INDEX IF NOT EXISTS idx_avh_tier ON account_violation_history(escalation_tier DESC);

ALTER TABLE enforcement_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_violation_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read enforcement_queue"
  ON enforcement_queue FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role can manage enforcement_queue"
  ON enforcement_queue FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can read account_violation_history"
  ON account_violation_history FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role can manage account_violation_history"
  ON account_violation_history FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- source: migrations/00010_emails_challenge_support.sql
-- ============================================================
-- Allow emails to be logged for challenge (the trading platform) accounts that have no row in the accounts table.
-- The accounts table uses UUIDs for internal accounts; the trading platform challenge accounts have numeric string IDs.

ALTER TABLE emails
  ALTER COLUMN account_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS challenge_account_id TEXT,
  ADD COLUMN IF NOT EXISTS sent_by_name TEXT;

CREATE INDEX IF NOT EXISTS idx_emails_challenge_account
  ON emails (challenge_account_id, template_type);

-- ============================================================
-- source: migrations/00010_reviewer_agent.sql
-- ============================================================
-- Migration: Reviewer Agent
-- Adds review tracking columns to enforcement_queue and creates reviewer_runs table

-- Extend enforcement_queue with review tracking columns
ALTER TABLE enforcement_queue
  ADD COLUMN IF NOT EXISTS reviewer_status TEXT CHECK (reviewer_status IN (
    'pending_review', 'deduction_confirmed', 'pending_deduction', 'review_error'
  )),
  ADD COLUMN IF NOT EXISTS reviewer_notes TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payout_ref VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_eq_reviewer_status
  ON enforcement_queue(reviewer_status)
  WHERE reviewer_status IS NOT NULL;

-- Reviewer run history table for observability
CREATE TABLE IF NOT EXISTS reviewer_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'deferred')) DEFAULT 'running',
  total_cases INTEGER NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  pending_deduction INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  platform_healthy BOOLEAN NOT NULL DEFAULT true,
  error_details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rr_status ON reviewer_runs(status);
CREATE INDEX IF NOT EXISTS idx_rr_created ON reviewer_runs(created_at DESC);

-- RLS
ALTER TABLE reviewer_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read reviewer_runs"
  ON reviewer_runs FOR SELECT TO authenticated USING (true);

CREATE POLICY "Service role can manage reviewer_runs"
  ON reviewer_runs FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- source: migrations/00012_evidence_and_decisions.sql
-- ============================================================
-- Evidence packs + explainable payout decisions.
-- evidence_packs: structured, versioned dossiers ("why we did this") that can
-- be attached to a payout/violation/account/investigation and cited by a
-- payout_decisions row. Both tables use TEXT ids for subject/account/payout
-- since the platform is provider-neutral (numeric trading-platform ids,
-- not internal accounts.id uuids) — mirrors payout_history/account_snapshots.

CREATE TABLE IF NOT EXISTS evidence_packs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('payout', 'violation', 'account', 'investigation')),
  subject_id    TEXT NOT NULL,
  account_id    TEXT,
  asset_class   TEXT,
  title         TEXT NOT NULL,
  pack          JSONB NOT NULL DEFAULT '{}',
  narrative     TEXT,
  created_by    TEXT,
  decision_id   UUID
);

CREATE INDEX IF NOT EXISTS idx_evidence_packs_subject ON evidence_packs (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_evidence_packs_account ON evidence_packs (account_id);

CREATE TABLE IF NOT EXISTS payout_decisions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payout_id         TEXT NOT NULL,
  account_id        TEXT,
  decision          TEXT NOT NULL CHECK (decision IN ('preapprove', 'approve', 'reject', 'hold')),
  actor             TEXT,
  rationale         JSONB NOT NULL DEFAULT '{}',
  explanation       TEXT,
  evidence_pack_id  UUID REFERENCES evidence_packs(id),
  audit_hash        TEXT
);

CREATE INDEX IF NOT EXISTS idx_payout_decisions_payout ON payout_decisions (payout_id);

-- Now that payout_decisions exists, wire the forward reference from
-- evidence_packs.decision_id (kept nullable — a pack can exist before a
-- decision is made, e.g. pre-decision investigative dossiers).
ALTER TABLE evidence_packs DROP CONSTRAINT IF EXISTS fk_evidence_packs_decision;
ALTER TABLE evidence_packs
  ADD CONSTRAINT fk_evidence_packs_decision
  FOREIGN KEY (decision_id) REFERENCES payout_decisions(id)
  ON DELETE SET NULL;

-- RLS
ALTER TABLE evidence_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read evidence_packs"
  ON evidence_packs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role can manage evidence_packs"
  ON evidence_packs FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can read payout_decisions"
  ON payout_decisions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role can manage payout_decisions"
  ON payout_decisions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- source: migrations/00013_audit_chain_serialize.sql
-- ============================================================
-- digest() lives in pgcrypto; the baseline only enables uuid-ossp.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION append_audit_event(
  p_action_type       TEXT,
  p_entity_type       TEXT,
  p_entity_id         TEXT,
  p_performed_by      TEXT,
  p_details           JSONB,
  p_details_canonical TEXT
) RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev_hash  TEXT;
  v_created_at TEXT;
  v_canonical  TEXT;
  v_entry_hash TEXT;
BEGIN
  -- Serialize all chain appends. Transaction-scoped: released on COMMIT/
  -- ROLLBACK, so concurrent writers block here instead of racing.
  PERFORM pg_advisory_xact_lock(hashtext('audit_log_chain'));

  SELECT entry_hash INTO v_prev_hash
  FROM audit_log
  ORDER BY created_at DESC
  LIMIT 1;

  v_prev_hash := COALESCE(v_prev_hash, 'GENESIS');

  -- ISO-8601 with millisecond precision + 'Z', matching JS toISOString().
  v_created_at := to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  -- Rebuild the exact canonical string the TS hashes:
  --   JSON.stringify(sortValue({ action_type, created_at_iso, details_json,
  --     entity_id, entity_type, performed_by, prev_hash }))
  -- Top-level keys are emitted in sorted order (identical to JS localeCompare
  -- for these ASCII identifiers). details_json is supplied pre-canonicalized so
  -- the nested object's key ordering, number formatting and string escaping
  -- match JS byte-for-byte. to_json(text) escapes strings the same way
  -- JSON.stringify does for the plain-ASCII values used here.
  v_canonical :=
    '{"action_type":'    || to_json(p_action_type)::text  ||
    ',"created_at_iso":' || to_json(v_created_at)::text   ||
    ',"details_json":'   || p_details_canonical           ||
    ',"entity_id":'      || to_json(p_entity_id)::text    ||
    ',"entity_type":'    || to_json(p_entity_type)::text  ||
    ',"performed_by":'   || to_json(p_performed_by)::text ||
    ',"prev_hash":'      || to_json(v_prev_hash)::text    ||
    '}';

  v_entry_hash := encode(digest(v_canonical, 'sha256'), 'hex');

  INSERT INTO audit_log (
    action_type, entity_type, entity_id, performed_by,
    details_json, prev_hash, entry_hash, created_at
  ) VALUES (
    p_action_type, p_entity_type, p_entity_id, p_performed_by,
    p_details, v_prev_hash, v_entry_hash, v_created_at::timestamptz
  );

  RETURN v_entry_hash;
END;
$$;

GRANT EXECUTE ON FUNCTION append_audit_event(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT)
  TO service_role, authenticated;

-- ============================================================
-- source: migrations/00014_execute_deduction_atomic.sql
-- ============================================================
CREATE OR REPLACE FUNCTION execute_deduction_atomic(
  p_account_id     UUID,
  p_violation_id   UUID,
  p_amount         NUMERIC,
  p_pre_balance    NUMERIC,
  p_post_balance   NUMERIC,
  p_executed_by    TEXT,
  p_execution_type TEXT,
  p_reason         TEXT
) RETURNS deductions
LANGUAGE plpgsql
AS $$
DECLARE
  v_row deductions;
BEGIN
  INSERT INTO deductions (
    violation_id, account_id, amount, pre_balance, post_balance,
    executed_by, execution_type, reason
  ) VALUES (
    p_violation_id, p_account_id, p_amount, p_pre_balance, p_post_balance,
    COALESCE(p_executed_by, 'system'),
    p_execution_type::deduction_execution_type, p_reason
  )
  RETURNING * INTO v_row;

  UPDATE accounts SET balance = p_post_balance WHERE id = p_account_id;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION execute_deduction_atomic(UUID, UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT)
  TO service_role, authenticated;

-- Notify PostgREST to reload schema so the new RPCs are immediately callable.
NOTIFY pgrst, 'reload schema';
