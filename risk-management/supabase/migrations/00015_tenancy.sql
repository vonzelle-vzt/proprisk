-- 00015_tenancy.sql
--
-- Turns a single-tenant deployment into a hard-isolated multi-tenant one.
--
-- The product promise is that no prop firm can ever see another firm's data.
-- That promise is enforced in five independent layers (see docs/ISOLATION.md);
-- this migration is layers 1 and 2 — the tenant dimension itself, and RLS
-- predicates that actually constrain rows.
--
-- Before this migration every policy read `USING (true)`: RLS was enabled but
-- authorised every authenticated user to every row. It provided authentication
-- gating and zero isolation.
--
-- DESIGN NOTE — why the policies below are generated in a loop rather than
-- written out 88 times. The uniform tenant predicate must apply to EVERY
-- tenant-scoped table with no exceptions; a hand-written list of 88 policies
-- is a list with a typo in it, and a typo here is a data leak. Generating from
-- one canonical table list makes "a table was missed" structurally impossible,
-- and the cross-tenant isolation suite verifies the result empirically rather
-- than by reading SQL. Special cases are written explicitly below the loop.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Tenant identity
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenants (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(200) NOT NULL,
  slug            VARCHAR(80)  NOT NULL UNIQUE,
  plan_tier       VARCHAR(40)  NOT NULL DEFAULT 'starter',
  status          VARCHAR(20)  NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'cancelled')),
  -- Runtime branding. Build-time NEXT_PUBLIC_BRAND_* vars cannot work in a
  -- shared deployment because they are inlined at build.
  branding_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Entitlements are enforced against this ceiling (pricing is tiered by the
  -- number of funded accounts monitored).
  max_accounts    INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tenants IS 'One prop firm. The unit of data isolation and billing.';

-- A user belongs to a tenant WITH a role. Roles were previously flat and global
-- (a bare string in app_metadata with no tenant dimension), so there was no way
-- to be an admin of one firm and nothing of another.
CREATE TABLE IF NOT EXISTS tenant_members (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL,
  role         VARCHAR(30) NOT NULL
                 CHECK (role IN ('owner', 'admin', 'risk_manager', 'risk_analyst', 'viewer')),
  invited_by   UUID,
  invited_at   TIMESTAMPTZ,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_members_user ON tenant_members(user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_members_tenant ON tenant_members(tenant_id);

-- Invites are bound to the issuing tenant and cannot be redeemed into another.
CREATE TABLE IF NOT EXISTS tenant_invites (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         VARCHAR(320) NOT NULL,
  role          VARCHAR(30) NOT NULL
                  CHECK (role IN ('admin', 'risk_manager', 'risk_analyst', 'viewer')),
  token_hash    TEXT NOT NULL UNIQUE,
  invited_by    UUID NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  accepted_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_invites_tenant ON tenant_invites(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_invites_email ON tenant_invites(lower(email));

-- ---------------------------------------------------------------------------
-- 2. JWT claim helpers
-- ---------------------------------------------------------------------------
--
-- SECURITY INVOKER (the default) is mandatory here. A SECURITY DEFINER helper
-- would evaluate with the definer's rights and could be used to escape the very
-- policies it feeds.
--
-- A NULL return DENIES rather than permits: `tenant_id = NULL` evaluates to
-- NULL, which is not TRUE, so the policy fails closed. A token with no tenant
-- claim therefore sees nothing at all.

CREATE OR REPLACE FUNCTION auth_tenant_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(
    COALESCE(
      current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'tenant_id',
      ''
    ),
    ''
  )::uuid
$$;

COMMENT ON FUNCTION auth_tenant_id() IS
  'Tenant claim from the JWT app_metadata. NULL (no claim) fails every policy closed.';

CREATE OR REPLACE FUNCTION auth_tenant_role()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role',
    ''
  )
$$;

COMMENT ON FUNCTION auth_tenant_role() IS
  'Role claim from the JWT app_metadata. Never read from user_metadata — that is user-writable.';

-- ---------------------------------------------------------------------------
-- 3. Seed tenant + backfill
-- ---------------------------------------------------------------------------
-- Existing rows predate tenancy and all belong to the original deployment's
-- firm. They are adopted by one seed tenant so `tenant_id` can be NOT NULL.

INSERT INTO tenants (id, name, slug, plan_tier, status)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Seed Tenant (pre-tenancy data)',
  'seed',
  'enterprise',
  'active'
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Add tenant_id to every tenant-scoped table
-- ---------------------------------------------------------------------------
--
-- `news_events` is deliberately EXCLUDED: the economic calendar is shared
-- reference data (the same ECB rate decision for everyone), not tenant data.
-- It is readable by all authenticated users and writable only by service_role.
--
-- `violation_config` is dropped in 00018 — it has never been read by a single
-- line of application code and is superseded by rule packs.

DO $$
DECLARE
  t TEXT;
  tenant_tables TEXT[] := ARRAY[
    'accounts',
    'trades',
    'violations',
    'deductions',
    'emails',
    'audit_log',
    'violation_config',
    'risk_profiles',
    'risk_pretrade_decisions',
    'risk_trade_events',
    'risk_violations',
    'risk_alerts',
    'risk_session_reports',
    'payout_history',
    'challenge_violation_cache',
    'challenge_sync_progress',
    'account_snapshots',
    'fraud_investigations',
    'enforcement_queue',
    'account_violation_history',
    'reviewer_runs',
    'evidence_packs',
    'payout_decisions'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'skipping %, table not present', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id UUID', t);

    -- Adopt pre-tenancy rows.
    EXECUTE format(
      'UPDATE %I SET tenant_id = %L WHERE tenant_id IS NULL',
      t, '00000000-0000-0000-0000-000000000001'
    );

    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', t);

    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
      t, t || '_tenant_id_fkey'
    );
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) '
      'REFERENCES tenants(id) ON DELETE CASCADE',
      t, t || '_tenant_id_fkey'
    );

    -- Every tenant-scoped query filters on tenant_id, so it leads the index.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)',
      'idx_' || t || '_tenant', t
    );
  END LOOP;
END $$;

-- Composite indexes on the hot paths, tenant_id first.
CREATE INDEX IF NOT EXISTS idx_accounts_tenant_active   ON accounts(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_trades_tenant_account    ON trades(tenant_id, account_id);
CREATE INDEX IF NOT EXISTS idx_violations_tenant_type   ON violations(tenant_id, violation_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_created ON audit_log(tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. Replace every USING(true) policy with a real tenant predicate
-- ---------------------------------------------------------------------------
--
-- Per-operation policies, and INSERT/UPDATE carry WITH CHECK so a row can never
-- be written INTO another tenant (a USING-only policy would let a caller move a
-- row across the boundary on UPDATE).

DO $$
DECLARE
  t TEXT;
  pol RECORD;
  tenant_tables TEXT[] := ARRAY[
    'accounts', 'trades', 'violations', 'deductions', 'emails', 'audit_log',
    'violation_config', 'risk_profiles', 'risk_pretrade_decisions',
    'risk_trade_events', 'risk_violations', 'risk_alerts',
    'risk_session_reports', 'payout_history', 'challenge_violation_cache',
    'challenge_sync_progress', 'account_snapshots', 'fraud_investigations',
    'enforcement_queue', 'account_violation_history', 'reviewer_runs',
    'evidence_packs', 'payout_decisions'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;

    -- Drop EVERY pre-existing policy on the table. Leaving one behind would
    -- leave a USING(true) hole beside the new predicate — policies are OR-ed,
    -- so one permissive leftover defeats all of the new ones.
    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol.policyname, t);
    END LOOP;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- Table owners bypass RLS unless it is forced; the migration runs as owner.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (tenant_id = auth_tenant_id())',
      'tenant_select_' || t, t
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (tenant_id = auth_tenant_id())',
      'tenant_insert_' || t, t
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE TO authenticated '
      'USING (tenant_id = auth_tenant_id()) WITH CHECK (tenant_id = auth_tenant_id())',
      'tenant_update_' || t, t
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (tenant_id = auth_tenant_id())',
      'tenant_delete_' || t, t
    );

    -- Background workers (crons, ingestion) legitimately need to cross tenants.
    -- They reach the DB as service_role and are constrained in application code
    -- by the scoped data-access layer, which refuses a query without an
    -- explicit tenant_id.
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      'service_all_' || t, t
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Policies for the tenancy tables themselves
-- ---------------------------------------------------------------------------

ALTER TABLE tenants        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants        FORCE  ROW LEVEL SECURITY;
ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_members FORCE  ROW LEVEL SECURITY;
ALTER TABLE tenant_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_invites FORCE  ROW LEVEL SECURITY;

-- A firm sees its own tenant row and nothing else.
CREATE POLICY tenant_select_self ON tenants
  FOR SELECT TO authenticated USING (id = auth_tenant_id());
-- Renaming/rebranding is owner|admin work; plan_tier and status are set by
-- billing through service_role, never by the customer.
CREATE POLICY tenant_update_self ON tenants
  FOR UPDATE TO authenticated
  USING (id = auth_tenant_id() AND auth_tenant_role() IN ('owner', 'admin'))
  WITH CHECK (id = auth_tenant_id());
CREATE POLICY tenant_service_all ON tenants
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Members see their own firm's roster.
CREATE POLICY tenant_members_select ON tenant_members
  FOR SELECT TO authenticated USING (tenant_id = auth_tenant_id());
-- Only owner|admin may change the roster, and only within their own tenant.
CREATE POLICY tenant_members_write ON tenant_members
  FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id() AND auth_tenant_role() IN ('owner', 'admin'))
  WITH CHECK (tenant_id = auth_tenant_id() AND auth_tenant_role() IN ('owner', 'admin'));
CREATE POLICY tenant_members_service ON tenant_members
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY tenant_invites_select ON tenant_invites
  FOR SELECT TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY tenant_invites_write ON tenant_invites
  FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id() AND auth_tenant_role() IN ('owner', 'admin'))
  WITH CHECK (tenant_id = auth_tenant_id() AND auth_tenant_role() IN ('owner', 'admin'));
-- Redemption happens before the redeemer has a tenant claim, so it runs
-- server-side as service_role.
CREATE POLICY tenant_invites_service ON tenant_invites
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 7. news_events — shared reference data, explicitly not tenant-scoped
-- ---------------------------------------------------------------------------

DO $$
DECLARE pol RECORD;
BEGIN
  IF to_regclass('public.news_events') IS NULL THEN RETURN; END IF;

  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'news_events'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON news_events', pol.policyname);
  END LOOP;

  ALTER TABLE news_events ENABLE ROW LEVEL SECURITY;
  ALTER TABLE news_events FORCE ROW LEVEL SECURITY;

  -- The economic calendar is the same for every firm: readable by all, written
  -- only by the sync cron.
  CREATE POLICY news_events_read ON news_events
    FOR SELECT TO authenticated USING (true);
  CREATE POLICY news_events_service ON news_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);
END $$;

-- ---------------------------------------------------------------------------
-- 8. Re-scope global UNIQUE constraints that would collide across tenants
-- ---------------------------------------------------------------------------
--
-- These constraints were correct when one deployment meant one firm. Shared,
-- they are collision bugs: every one below is keyed on an identifier issued by
-- the *provider*, not by us, so two firms routinely hold the same value. Firm B
-- onboarding an account numbered 1001 would fail because Firm A already has one
-- — an outage that looks like a mysterious insert error, not a design fault.
--
-- Constraints keyed on `account_id` are deliberately left alone: `accounts.id`
-- is a UUID that already belongs to exactly one tenant, so anything derived
-- from it is transitively tenant-unique and gains nothing from a wider key.

-- These were declared inconsistently across the migration history: some as
-- table constraints, some as bare unique indexes. Drop whichever form exists
-- before recreating, so this migration is not sensitive to which one a given
-- database happens to have.
DO $$
DECLARE
  spec RECORD;
  specs CONSTANT TEXT[][] := ARRAY[
    ARRAY['accounts',             'accounts_login_key',   'tenant_id, login'],
    ARRAY['account_snapshots',    'uq_account_snapshot',  'tenant_id, platform_account_id'],
    ARRAY['fraud_investigations', 'uq_fraud_dedupe',      'tenant_id, dedupe_key'],
    ARRAY['payout_history',       'uq_payout_decision',   'tenant_id, platform_payout_id, decision']
  ];
  i INT;
  tbl TEXT; nm TEXT; cols TEXT;
BEGIN
  FOR i IN 1 .. array_length(specs, 1) LOOP
    tbl := specs[i][1]; nm := specs[i][2]; cols := specs[i][3];
    IF to_regclass('public.' || tbl) IS NULL THEN CONTINUE; END IF;

    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', tbl, nm);
    EXECUTE format('DROP INDEX IF EXISTS %I', nm);
    EXECUTE format('CREATE UNIQUE INDEX %I ON %I (%s)', nm, tbl, cols);
  END LOOP;
END $$;

-- Tenant slugs are the public identifier; keep them globally unique (already
-- declared UNIQUE on the table) so a slug always names exactly one firm.

COMMIT;
