-- 00016_connections.sql
--
-- Per-tenant provider credentials. Before this migration every deployment's
-- MatchTrader/Tradovate/etc. credentials came from process.env — one set per
-- process, shared by every firm. Under shared tenancy that is a cross-tenant
-- credential leak waiting to happen (Firm A's futures desk would trade on
-- Firm B's Tradovate account). This table gives each tenant its own row per
-- provider; secrets are envelope-encrypted at rest (src/lib/crypto/envelope.ts)
-- so a database dump alone never yields a usable credential.
--
-- Policy shape mirrors 00015_tenancy.sql exactly (four per-operation
-- authenticated policies + one service_role FOR ALL), not generated from the
-- tenant_tables loop because this table postdates that migration and is
-- created directly with RLS already correct.

BEGIN;

CREATE TABLE IF NOT EXISTS connections (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_id        VARCHAR(40) NOT NULL,
  asset_class        VARCHAR(20) NOT NULL CHECK (asset_class IN ('forex', 'futures')),
  enabled            BOOLEAN NOT NULL DEFAULT false,
  api_url            TEXT,
  -- Envelope-encrypted JSON blob (apiKey + provider-specific extras). Never
  -- selected by application code outside src/lib/connections/store.ts.
  encrypted_secrets  TEXT,
  key_version        INTEGER NOT NULL DEFAULT 1,
  status             VARCHAR(20) NOT NULL DEFAULT 'unvalidated'
                       CHECK (status IN ('unvalidated', 'valid', 'invalid')),
  last_validated_at  TIMESTAMPTZ,
  last_error         TEXT,
  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, provider_id)
);

-- Every query filters on tenant_id first; this is the hot path for provider
-- resolution (one lookup per request that touches a live provider).
CREATE INDEX IF NOT EXISTS idx_connections_tenant ON connections (tenant_id);
CREATE INDEX IF NOT EXISTS idx_connections_tenant_provider ON connections (tenant_id, provider_id);

ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_connections ON connections
  FOR SELECT TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY tenant_insert_connections ON connections
  FOR INSERT TO authenticated WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_update_connections ON connections
  FOR UPDATE TO authenticated
  USING (tenant_id = auth_tenant_id()) WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_delete_connections ON connections
  FOR DELETE TO authenticated USING (tenant_id = auth_tenant_id());

-- Route handlers reach this table via tenantDb() (service_role) rather than
-- the user's session, same as every other tenant-scoped table (see
-- src/lib/db/tenant-scoped.ts) — the service_role policy is what actually
-- authorizes those reads/writes; the authenticated policies above are a second
-- line of defense if a client ever queries this table directly.
CREATE POLICY service_all_connections ON connections
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER set_connections_updated_at
  BEFORE UPDATE ON connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMIT;
