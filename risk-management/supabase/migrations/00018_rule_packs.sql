-- 00018_rule_packs.sql
--
-- Persistence for the Rule Pack engine (src/lib/rulepack).
--
-- Two ideas carry this schema:
--
--  1. A rule pack is VERSIONED and IMMUTABLE once it leaves draft. A breach
--     decision must remain explicable years later, when the firm has changed
--     its rules twice — so every decision pins the exact pack version that
--     produced it, and an active pack can never be edited in place.
--
--  2. A decision's identity comes from its INPUTS, not from the clock. The
--     engines this replaces deduped on a wall-clock window (one hour in one
--     path, six in another), which gives a different answer depending on when
--     the job happened to run and makes replay impossible.

BEGIN;

-- ---------------------------------------------------------------------------
-- Rule packs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rule_packs (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           VARCHAR(120) NOT NULL,
  asset_class    VARCHAR(10) NOT NULL CHECK (asset_class IN ('forex', 'futures')),
  version        INTEGER NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'testing', 'active', 'archived')),
  schema_version INTEGER NOT NULL,
  pack_json      JSONB NOT NULL,
  -- sha256 of the canonicalised pack. Two packs with the same content hash are
  -- the same rules, which is how a "publish" that changed nothing is detected.
  content_hash   TEXT NOT NULL,
  -- Which preset it started from, if any. Kept so a firm can be told when the
  -- preset it derived from has been revised.
  derived_from   VARCHAR(60),
  created_by     UUID,
  -- A pack cannot enforce until a human approves it. Draft -> testing is
  -- self-serve; testing -> active requires this to be set.
  approved_by    UUID,
  approved_at    TIMESTAMPTZ,
  effective_from TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, name, version)
);

CREATE INDEX IF NOT EXISTS idx_rule_packs_tenant ON rule_packs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rule_packs_tenant_status ON rule_packs(tenant_id, status);

-- At most ONE active pack per tenant per asset class. Two active packs would
-- make "which rules applied?" unanswerable at exactly the moment a trader
-- disputes a breach, so the constraint is in the database rather than in a
-- code path that can be bypassed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rule_packs_one_active
  ON rule_packs (tenant_id, asset_class)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Breach decisions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS breach_decisions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_pack_id     UUID NOT NULL REFERENCES rule_packs(id) ON DELETE RESTRICT,
  -- Denormalised so the decision stays readable even if the pack row is
  -- renamed; the FK above already prevents the pack being deleted.
  rule_pack_version INTEGER NOT NULL,
  account_id       VARCHAR(100) NOT NULL,
  rule_id          VARCHAR(40) NOT NULL,
  action           VARCHAR(20) NOT NULL
                     CHECK (action IN ('terminate', 'pause_trading', 'flag_for_review', 'warn')),
  exceeded_by      NUMERIC(15,2),
  session_day      DATE,
  evidence_json    JSONB NOT NULL,
  -- FALSE for shadow-mode/backtest decisions. Shadow runs share the live code
  -- path exactly; only this flag and the absence of downstream enforcement
  -- differ, so a backtest can never disagree with production.
  enforced         BOOLEAN NOT NULL DEFAULT false,
  -- sha256 over pack version + account + rule + measured inputs.
  idempotency_key  TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, idempotency_key, enforced)
);

CREATE INDEX IF NOT EXISTS idx_breach_decisions_tenant ON breach_decisions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_breach_decisions_tenant_account
  ON breach_decisions(tenant_id, account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_breach_decisions_tenant_pack
  ON breach_decisions(tenant_id, rule_pack_id);

-- ---------------------------------------------------------------------------
-- Backtest runs
-- ---------------------------------------------------------------------------
-- A shadow run replays history through a candidate pack and reconciles the
-- result against what the firm's own platform reported. This is what lets a
-- firm trust the engine without a sales call, so the comparison is a
-- first-class record rather than a transient API response.

CREATE TABLE IF NOT EXISTS backtest_runs (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_pack_id        UUID NOT NULL REFERENCES rule_packs(id) ON DELETE CASCADE,
  rule_pack_version   INTEGER NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'complete', 'failed')),
  window_start        TIMESTAMPTZ NOT NULL,
  window_end          TIMESTAMPTZ NOT NULL,
  accounts_evaluated  INTEGER NOT NULL DEFAULT 0,
  engine_breaches     INTEGER NOT NULL DEFAULT 0,
  provider_breaches   INTEGER NOT NULL DEFAULT 0,
  -- The differences, both ways: breaches we found that the platform did not,
  -- and breaches it reported that we did not. The second direction is the one
  -- that matters — it is where the firm's rulebook and the pack disagree.
  reconciliation_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Rules that could not be evaluated, and why. A firm must be able to tell
  -- "no breach" from "not checked".
  skipped_json        JSONB NOT NULL DEFAULT '[]'::jsonb,
  error               TEXT,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_tenant ON backtest_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_tenant_pack
  ON backtest_runs(tenant_id, rule_pack_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- RLS — identical shape to every other tenant table (see 00015)
-- ---------------------------------------------------------------------------

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['rule_packs', 'breach_decisions', 'backtest_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (tenant_id = auth_tenant_id())',
      'tenant_select_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (tenant_id = auth_tenant_id())',
      'tenant_insert_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE TO authenticated '
      'USING (tenant_id = auth_tenant_id()) WITH CHECK (tenant_id = auth_tenant_id())',
      'tenant_update_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (tenant_id = auth_tenant_id())',
      'tenant_delete_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      'service_all_' || t, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Retire violation_config
-- ---------------------------------------------------------------------------
-- Designed for exactly this purpose and never read by a single line of
-- application code. Rule packs supersede it, and leaving a second, empty
-- configuration surface in place invites someone to wire it up in parallel.

DROP TABLE IF EXISTS violation_config;

COMMIT;
