-- 00024_morning_reports.sql
--
-- Creates a table the application has been writing to since before tenancy —
-- and which has never existed.
--
-- `src/app/api/cron/morning-report/route.ts` inserts into `morning_reports`,
-- and `src/app/api/ai/chat/route.ts` reads from it. Neither the squashed
-- baseline nor any of the 23 migrations creates it. Every insert has therefore
-- failed, and both call sites swallow the error: the cron logs and reports
-- `stored: false`, the reader catches and falls through to regenerating live.
--
-- So the feature appeared to work while persisting nothing. That is the failure
-- shape this codebase keeps producing — a job that reports success while doing
-- less than it claims — and it is why the table is being created with the
-- tenant column it always needed rather than papering over it by folding
-- `tenant_id` into a JSON blob.

BEGIN;

CREATE TABLE IF NOT EXISTS morning_reports (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Rendered prose, kept alongside the structured data so a report reads the
  -- same months later even if the formatter changes.
  summary      TEXT NOT NULL,
  data         JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE morning_reports IS
  'Daily risk digest per tenant. Written by the morning-report cron, read by '
  'the dashboard and the assistant.';

-- The only query is "most recent for this tenant", so the index matches it.
CREATE INDEX IF NOT EXISTS idx_morning_reports_tenant_generated
  ON morning_reports (tenant_id, generated_at DESC);

-- Same RLS shape as every other tenant table (see 00015).
ALTER TABLE morning_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE morning_reports FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_select_morning_reports ON morning_reports
  FOR SELECT TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY tenant_insert_morning_reports ON morning_reports
  FOR INSERT TO authenticated WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_update_morning_reports ON morning_reports
  FOR UPDATE TO authenticated
  USING (tenant_id = auth_tenant_id()) WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_delete_morning_reports ON morning_reports
  FOR DELETE TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY service_all_morning_reports ON morning_reports
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
