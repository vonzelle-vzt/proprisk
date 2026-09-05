-- 00023_disputes.sql
--
-- Dispute mode (docs/HOW-IT-WORKS.md §6.4): today a trader dispute happens
-- over email and nothing joins the record. This table is the flow — a
-- dispute opened against a breach/payout/deduction decision, carrying the
-- evidence pack that existed AT DECISION TIME (see src/lib/disputes/lifecycle.ts
-- for why the pack is looked up, not rebuilt) and resolved with a written
-- outcome that joins the hash-chained audit trail like every other decision.
--
-- Follows the EXACT RLS shape established in 00015_tenancy.sql /
-- 00017_support_tickets.sql: ENABLE + FORCE, four authenticated policies
-- keyed on `tenant_id = auth_tenant_id()` with WITH CHECK on write paths,
-- plus one service_role FOR ALL policy (routes here run server-side via
-- tenantDb(), the same pattern src/lib/support/tickets.ts uses).

BEGIN;

CREATE TABLE IF NOT EXISTS disputes (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- What decision is being disputed. subject_id/account_id are TEXT, matching
  -- evidence_packs and payout_decisions — the platform is provider-neutral,
  -- so these may be provider-issued ids, not internal accounts.id uuids.
  subject_type      VARCHAR(20) NOT NULL CHECK (subject_type IN ('breach', 'payout', 'deduction')),
  subject_id        TEXT NOT NULL,
  account_id        TEXT,

  raised_by         TEXT NOT NULL,
  raised_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trader_statement  TEXT NOT NULL,

  status            VARCHAR(20) NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'under_review', 'upheld', 'overturned', 'withdrawn')),

  -- Required once the case leaves 'open'/'under_review' into a terminal
  -- status — enforced in application code (src/lib/disputes/lifecycle.ts),
  -- not here, so the row can still be created with these NULL while open.
  resolution        TEXT,
  resolved_by       TEXT,
  resolved_at       TIMESTAMPTZ,

  -- The evidence pack pinned at open time. Nullable: a pack could not be
  -- located or built (e.g. the underlying decision predates evidence packs).
  evidence_pack_id  UUID REFERENCES evidence_packs(id),

  -- Pointer into the hash-chained audit_log for the most recent state change
  -- on this dispute, mirroring payout_decisions.audit_hash.
  audit_hash        TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE disputes IS
  'Trader disputes against a breach/payout/deduction decision. The evidence pack is snapshotted at open time; every state change joins the audit chain.';

-- Every tenant-scoped query filters on tenant_id, so it leads every index.
CREATE INDEX IF NOT EXISTS idx_disputes_tenant           ON disputes(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_disputes_tenant_status     ON disputes(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_disputes_tenant_subject     ON disputes(tenant_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_disputes_account            ON disputes(tenant_id, account_id);

ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_select_disputes ON disputes
  FOR SELECT TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY tenant_insert_disputes ON disputes
  FOR INSERT TO authenticated WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_update_disputes ON disputes
  FOR UPDATE TO authenticated
  USING (tenant_id = auth_tenant_id()) WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_delete_disputes ON disputes
  FOR DELETE TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY service_all_disputes ON disputes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
