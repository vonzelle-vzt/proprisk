-- 00021_trader_access.sql
--
-- Trader-facing read access, without a trader account.
--
-- Every existing session in this product belongs to a FIRM (tenant_members),
-- and the whole app is deny-by-default around that fact (middleware.ts). A
-- trader is deliberately not given one: they are not a member of the tenant,
-- they have no role, and creating an account for every trader of every
-- customer firm would be its own multi-tenant identity problem. Instead a
-- trader gets a single-purpose, single-account, revocable link.
--
-- The token is the entire authentication mechanism, so only its hash is ever
-- persisted (mirrors tenant_invites.token_hash in 00015_tenancy.sql) — a
-- database dump must never yield a usable link. A token grants read access to
-- EXACTLY ONE account: there is no scope broader than `account_id` on this
-- table, so there is no code path by which possessing one trader's link could
-- reach another trader's account, let alone another tenant's.
--
-- Policy shape mirrors 00015_tenancy.sql exactly (four per-operation
-- authenticated policies + one service_role FOR ALL), written directly rather
-- than through the tenant_tables loop because this table postdates that
-- migration (same approach as 00016_connections.sql).

BEGIN;

CREATE TABLE IF NOT EXISTS trader_access_tokens (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- sha256 hex digest of the raw token. The raw token is returned exactly
  -- once, at creation, to the firm that requested the link; it is never
  -- written to this table or logged anywhere.
  token_hash      TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  -- tenant_members.user_id (the risk manager who generated the link). No FK:
  -- tenant_members itself does not FK to auth.users either (see 00015).
  created_by      UUID NOT NULL,
  last_viewed_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Minted by us, not a provider, so a single global uniqueness domain is
  -- correct (see ISOLATION.md "scope any UNIQUE constraint keyed on a
  -- provider-issued value" — this one isn't, so it does NOT need tenant_id).
  -- A trader's own link carries no tenant id, so lookup at verification time
  -- has to work from the hash alone.
  UNIQUE (token_hash)
);

-- Every tenant-scoped query filters on tenant_id first (firm-side list/revoke
-- screens); the trader-side verification path looks up by token_hash, which
-- is already unique above.
CREATE INDEX IF NOT EXISTS idx_trader_access_tokens_tenant ON trader_access_tokens(tenant_id);
CREATE INDEX IF NOT EXISTS idx_trader_access_tokens_account ON trader_access_tokens(tenant_id, account_id);

ALTER TABLE trader_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_access_tokens FORCE ROW LEVEL SECURITY;

-- The firm sees and manages only its own tenant's links. The trader who
-- actually holds a link has no Supabase session at all (see middleware.ts —
-- traders are not tenant members), so their read happens exclusively through
-- the service_role policy below, mediated by src/lib/trader/tokens.ts, which
-- verifies the token BEFORE any row is exposed to the caller.
CREATE POLICY tenant_select_trader_access_tokens ON trader_access_tokens
  FOR SELECT TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY tenant_insert_trader_access_tokens ON trader_access_tokens
  FOR INSERT TO authenticated WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_update_trader_access_tokens ON trader_access_tokens
  FOR UPDATE TO authenticated
  USING (tenant_id = auth_tenant_id()) WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_delete_trader_access_tokens ON trader_access_tokens
  FOR DELETE TO authenticated USING (tenant_id = auth_tenant_id());

CREATE POLICY service_all_trader_access_tokens ON trader_access_tokens
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
