-- 00017_support_tickets.sql
--
-- The "don't babysit me" surface: a firm hitting a wall stops needing to
-- email the support inbox directly and re-explain their setup
-- from scratch. Filing a ticket in-app auto-attaches everything a human
-- would ask for anyway (which tenant, which plan, which connections are
-- live, what broke) so first response can be a fix, not a round of
-- "what tenant are you on".
--
-- Follows the EXACT RLS shape established in 00015_tenancy.sql: ENABLE +
-- FORCE, four authenticated policies keyed on `tenant_id = auth_tenant_id()`
-- with WITH CHECK on write paths, plus one service_role FOR ALL policy for
-- the ticket-creation route (which runs server-side, before RLS can help,
-- exactly like tenant_invites).

BEGIN;

CREATE TABLE IF NOT EXISTS support_tickets (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by       UUID NOT NULL,
  subject          VARCHAR(200) NOT NULL,
  body             TEXT NOT NULL,
  severity         VARCHAR(20) NOT NULL DEFAULT 'normal'
                     CHECK (severity IN ('low', 'normal', 'high', 'urgent')),
  status           VARCHAR(20) NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'in_progress', 'resolved')),
  -- Snapshot at filing time: tenant id/name, plan_tier, connection/adapter
  -- status, app version/commit, recent error context. See
  -- src/lib/support/diagnostics.ts for the shape.
  diagnostics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE support_tickets IS
  'In-app "Get help" tickets. Auto-attached diagnostics so a ticket arrives already debuggable.';

CREATE INDEX IF NOT EXISTS idx_support_tickets_tenant ON support_tickets(tenant_id, created_at DESC);

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_select_support_tickets ON support_tickets
  FOR SELECT TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY tenant_insert_support_tickets ON support_tickets
  FOR INSERT TO authenticated WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_update_support_tickets ON support_tickets
  FOR UPDATE TO authenticated
  USING (tenant_id = auth_tenant_id()) WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_delete_support_tickets ON support_tickets
  FOR DELETE TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY service_all_support_tickets ON support_tickets
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
