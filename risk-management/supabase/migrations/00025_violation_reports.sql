-- 00025_violation_reports.sql
--
-- The per-violation decision record (docs/HOW-IT-WORKS.md §2 Flow 3): the
-- rule as written, what happened, the arithmetic, the trades, and everything
-- the firm did about it — rendered to PDF and CSV for the risk desk and for
-- the trader whose account it is.
--
-- WHY THE PAYLOAD IS PERSISTED RATHER THAN REBUILT ON DEMAND
--
-- A report that is rebuilt at download time is not evidence, it is a query
-- result — and the inputs it queries do not survive:
--
--   * `equity_snapshots` are PRUNED after 7 days (00022's retention note and
--     `src/lib/ingest/snapshots.ts`). The intraday peak that justified a
--     trailing-drawdown breach is gone by the time a dispute reaches week two.
--   * A rule pack is versioned but a firm edits its thresholds; a legacy
--     threshold in `src/config/violations.ts` is a code constant that moves
--     with a deploy. Rebuilding tomorrow re-states the breach against
--     TODAY'S rule, which is the single worst thing a decision record can do.
--   * `accounts.balance` / `.equity` are live columns, overwritten on every
--     poll. The balance at detection time is not recoverable from them.
--
-- So the assembled payload is written once, hashed, and read back verbatim
-- afterwards. `content_hash` (sha256 over the canonical report minus its own
-- id/timestamp/actor) makes the write idempotent by INPUT: regenerating a
-- report whose underlying facts have not changed returns the existing row
-- instead of accumulating near-identical copies, and a genuine change in the
-- facts produces a second row rather than silently overwriting the first.
--
-- Following 00024's rule: the generator reports what it PERSISTED, not what
-- it attempted — `generated_at` and `audit_hash` come from the row, and the
-- audit entry is written after the insert lands, never before.
--
-- RLS is the shape established in 00015 and copied verbatim by 00023: ENABLE
-- + FORCE, four per-operation `authenticated` policies keyed on
-- `tenant_id = auth_tenant_id()` with WITH CHECK on every write path, plus
-- one service_role policy for the tenant-scoped server path (`tenantDb()`).

BEGIN;

CREATE TABLE IF NOT EXISTS violation_reports (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- No FK to violations(id): a report must outlive the row it describes, and
  -- ON DELETE CASCADE on an evidence artefact is a way to lose a dispute.
  -- Reports for a rule-pack finding that never produced a `violations` row
  -- carry the breach_decisions id here instead — hence subject_type.
  violation_id  UUID NOT NULL,
  -- Internal accounts.id, as VARCHAR to match enforcement_queue/breach_decisions
  -- (the platform is provider-neutral; this column also holds a provider-issued
  -- id where a finding never reached an internal account row).
  account_id    VARCHAR(100) NOT NULL,
  subject_type  VARCHAR(20) NOT NULL
                  CHECK (subject_type IN ('violation', 'breach_decision')),

  -- The whole assembled report (src/lib/reports/violation/types.ts,
  -- `ViolationReport`). Renderers are pure functions of this column, so a PDF
  -- downloaded months from now is byte-identical to the one downloaded today.
  report_json   JSONB NOT NULL,
  -- sha256 of the canonical (key-sorted) report WITHOUT reportId/generatedAt/
  -- generatedBy — i.e. a hash of the FACTS, not of this particular rendering.
  content_hash  TEXT NOT NULL,

  generated_by  VARCHAR(255) NOT NULL,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Pointer into the hash-chained audit_log, mirroring disputes.audit_hash /
  -- payout_decisions.audit_hash. NULL means the chain write did not land
  -- (demo mode, or a legacy schema) — the row still exists and says so.
  audit_hash    TEXT,

  -- Scoped by tenant, per docs/ISOLATION.md: two firms may legitimately hold
  -- reports whose content hashes collide, and a global unique key would let
  -- one firm's write fail because of another firm's row.
  UNIQUE (tenant_id, violation_id, content_hash)
);

COMMENT ON TABLE violation_reports IS
  'Persisted per-violation decision records (PDF/CSV source of truth). Written '
  'once per distinct content hash; read back verbatim so a report reads '
  'identically after the equity snapshots behind it have been pruned.';

-- Every tenant-scoped query filters on tenant_id, so it leads every index.
CREATE INDEX IF NOT EXISTS idx_violation_reports_tenant_violation
  ON violation_reports (tenant_id, violation_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_violation_reports_tenant_account
  ON violation_reports (tenant_id, account_id);

ALTER TABLE violation_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE violation_reports FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_select_violation_reports ON violation_reports
  FOR SELECT TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY tenant_insert_violation_reports ON violation_reports
  FOR INSERT TO authenticated WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_update_violation_reports ON violation_reports
  FOR UPDATE TO authenticated
  USING (tenant_id = auth_tenant_id()) WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_delete_violation_reports ON violation_reports
  FOR DELETE TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY service_all_violation_reports ON violation_reports
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
