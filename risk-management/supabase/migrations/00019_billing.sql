-- 00019_billing.sql
--
-- Usage-metered billing. Pricing is tiered by the number of funded accounts a
-- firm has us monitoring (see src/lib/billing/plans.ts for the tier table),
-- so this migration adds the two tables that let application code answer
-- "what does this tenant pay for" and "what is this tenant actually using."
--
-- `subscriptions` is the billing state mirrored from Stripe (one row per
-- tenant; Stripe is the source of truth, this table is a read-optimised
-- cache kept in sync by the webhook handler). `usage_snapshots` is an
-- append-only metering ledger — one row per time a cron/report samples a
-- tenant's funded-account count, so usage over time is auditable rather than
-- only ever knowing the current instant.
--
-- RLS follows the exact shape 00015_tenancy.sql established for every other
-- tenant-scoped table: ENABLE + FORCE, one policy per operation for
-- `authenticated` scoped to `tenant_id = auth_tenant_id()` (INSERT/UPDATE
-- carry WITH CHECK so a row can never be written into another tenant), plus
-- an unconditional policy for `service_role` (the webhook handler and
-- metering cron have no user session to carry a tenant claim).

BEGIN;

CREATE TABLE IF NOT EXISTS subscriptions (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_customer_id      TEXT NOT NULL,
  stripe_subscription_id  TEXT,
  plan_tier               VARCHAR(40) NOT NULL DEFAULT 'starter',
  status                  VARCHAR(20) NOT NULL DEFAULT 'incomplete'
                            CHECK (status IN (
                              'incomplete', 'trialing', 'active', 'past_due',
                              'canceled', 'unpaid'
                            )),
  -- The account ceiling this subscription entitles the tenant to. Mirrored
  -- out of plan_tier at write time (see src/lib/billing/plans.ts) rather than
  -- looked up at read time, so a past invoice's entitlement is reconstructable
  -- even if the pricing table changes later.
  max_accounts            INTEGER,
  current_period_end      TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One Stripe subscription record per tenant. A tenant that churns and
  -- re-subscribes updates this row rather than inserting a second one; full
  -- history lives in Stripe, not duplicated here.
  UNIQUE (tenant_id),
  UNIQUE (stripe_customer_id)
);

COMMENT ON TABLE subscriptions IS
  'Billing state mirrored from Stripe via webhook. Stripe is authoritative; this is a synced read cache.';

CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription ON subscriptions(stripe_subscription_id);

CREATE TABLE IF NOT EXISTS usage_snapshots (
  id                         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id                  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  captured_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  funded_accounts_monitored  INTEGER NOT NULL CHECK (funded_accounts_monitored >= 0),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE usage_snapshots IS
  'Append-only metering ledger. One row per sample of a tenant''s funded-account count; never updated or deleted.';

CREATE INDEX IF NOT EXISTS idx_usage_snapshots_tenant ON usage_snapshots(tenant_id);
CREATE INDEX IF NOT EXISTS idx_usage_snapshots_tenant_captured ON usage_snapshots(tenant_id, captured_at DESC);

-- ---------------------------------------------------------------------------
-- RLS — identical shape to the 00015 loop, written out for these two tables.
-- ---------------------------------------------------------------------------

ALTER TABLE subscriptions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions    FORCE  ROW LEVEL SECURITY;
ALTER TABLE usage_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_snapshots  FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_select_subscriptions ON subscriptions
  FOR SELECT TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY tenant_insert_subscriptions ON subscriptions
  FOR INSERT TO authenticated WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_update_subscriptions ON subscriptions
  FOR UPDATE TO authenticated
  USING (tenant_id = auth_tenant_id()) WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_delete_subscriptions ON subscriptions
  FOR DELETE TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY service_all_subscriptions ON subscriptions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY tenant_select_usage_snapshots ON usage_snapshots
  FOR SELECT TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY tenant_insert_usage_snapshots ON usage_snapshots
  FOR INSERT TO authenticated WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_update_usage_snapshots ON usage_snapshots
  FOR UPDATE TO authenticated
  USING (tenant_id = auth_tenant_id()) WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_delete_usage_snapshots ON usage_snapshots
  FOR DELETE TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY service_all_usage_snapshots ON usage_snapshots
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
