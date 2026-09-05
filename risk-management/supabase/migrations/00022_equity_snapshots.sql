-- 00022_equity_snapshots.sql
--
-- Makes `drawdown.mode = trailing_intraday` and `daily_loss.basis =
-- highest_equity_of_day` evaluable. Both rules need the intraday equity
-- high-water mark, and a peak that occurs while a position is open never
-- appears in the closed-trade tape — see docs/HOW-IT-WORKS.md §6.2 and
-- src/lib/rulepack/types.ts's `EquitySnapshot`. Until now nothing ever wrote
-- one, so both primitives correctly reported `indeterminate` forever.
--
-- Two tables:
--
--   equity_snapshots — the time series itself. One row per observation,
--   whether it arrived by poll (src/app/api/cron/sample-equity) or push
--   (src/app/api/ingest/equity-snapshots).
--
--   ingest_keys — machine-to-machine auth for the push path. A firm whose
--   bridge process pushes snapshots authenticates with a bearer key, not a
--   session (there is no signed-in user on that request). This is
--   deliberately NOT the `connections` table (00016): `connections` holds
--   OUR outbound credentials to call a trading platform's API and is shaped
--   around (provider_id, asset_class); an ingest key authenticates an
--   INBOUND push from the firm's own infrastructure and has no provider or
--   asset-class dimension. Conflating the two would mean a firm's platform
--   credential and its push-auth secret expire, rotate and scope together
--   for no reason. Only the SHA-256 hash is ever stored, mirroring
--   `tenant_invites.token_hash` (00015) — a leaked database dump yields no
--   usable key, and issuance (src/lib/ingest/keys.ts) is the only place the
--   raw value is ever seen, at mint time.
--
-- RETENTION: raw snapshots are pruned after 7 days (see
-- src/lib/ingest/snapshots.ts: pruneSnapshots, called by the sampling cron
-- after every tenant's run — no separate pg_cron dependency). Seven days
-- covers the current session day plus a week of lookback for a trader
-- disputing a breach, while bounding growth for a firm sampling thousands of
-- accounts every few minutes. Anything a breach decision needs to survive
-- past that window belongs in the evidence pack (src/lib/evidence/builder),
-- which snapshots the specific numbers that mattered rather than the whole
-- feed.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. equity_snapshots
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS equity_snapshots (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Internal accounts.id (UUID), same FK every other per-account table in
  -- this schema uses (trades.account_id, violations.account_id, ...) — not
  -- the provider-native login, which is provider-issued and only meaningful
  -- as an argument to that provider's adapter calls.
  account_id               UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  captured_at              TIMESTAMPTZ NOT NULL,
  balance                  NUMERIC(15,2) NOT NULL,
  equity                   NUMERIC(15,2) NOT NULL,
  -- Redundant with (equity - balance) whenever both are known, but the push
  -- path may receive it directly from a platform that computes it natively
  -- and more precisely than we could derive it.
  open_pnl                 NUMERIC(15,2),
  source                   TEXT NOT NULL CHECK (source IN ('poll', 'push')),
  -- The fidelity bound this row can honestly claim: for `poll`, the sampling
  -- cron's configured cadence (EQUITY_SAMPLE_INTERVAL_SECONDS); for `push`,
  -- whatever the bridge reports about its own cadence, or NULL if it did not
  -- say. NULL means "unknown fidelity", not "tick-level" — the evaluator and
  -- any trader-facing explanation must say so rather than implying certainty
  -- a 60-second poll cannot back up. See src/lib/ingest/snapshots.ts.
  sample_interval_seconds  INTEGER,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency: a retried poll or a retried push for the same account at the
-- same observed instant is a no-op, not a duplicate row. Leads with
-- tenant_id per docs/ISOLATION.md's indexing convention, though account_id
-- alone already implies the tenant (accounts.id is a UUID we issue, not a
-- provider-issued identifier that could collide across tenants).
CREATE UNIQUE INDEX IF NOT EXISTS uq_equity_snapshot
  ON equity_snapshots (tenant_id, account_id, captured_at);

-- The query the evaluator actually runs: every snapshot for one account in a
-- session-day range, most recent first.
CREATE INDEX IF NOT EXISTS idx_equity_snapshots_window
  ON equity_snapshots (tenant_id, account_id, captured_at DESC);

-- Generic tenant index, for the retention prune (DELETE ... WHERE tenant_id =
-- $1 AND captured_at < $2) and any future per-tenant scan.
CREATE INDEX IF NOT EXISTS idx_equity_snapshots_tenant
  ON equity_snapshots (tenant_id);

ALTER TABLE equity_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE equity_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_equity_snapshots ON equity_snapshots
  FOR SELECT TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY tenant_insert_equity_snapshots ON equity_snapshots
  FOR INSERT TO authenticated WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_update_equity_snapshots ON equity_snapshots
  FOR UPDATE TO authenticated
  USING (tenant_id = auth_tenant_id()) WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_delete_equity_snapshots ON equity_snapshots
  FOR DELETE TO authenticated USING (tenant_id = auth_tenant_id());

-- Both ingestion paths (cron, push endpoint) write through tenantDb() as
-- service_role, same as every other background writer (docs/ISOLATION.md
-- layer 4) — the authenticated policies above are the second line of
-- defense if this table is ever queried directly from a session.
CREATE POLICY service_all_equity_snapshots ON equity_snapshots
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 2. ingest_keys
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest_keys (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- SHA-256 hex of the raw key. Globally unique (not per-tenant) because the
  -- push endpoint receives only the raw key and must look up its owning
  -- tenant from it — there is no tenant claim to scope the lookup by yet.
  key_hash       TEXT NOT NULL UNIQUE,
  label          TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ingest_keys_tenant ON ingest_keys (tenant_id);

ALTER TABLE ingest_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_ingest_keys ON ingest_keys
  FOR SELECT TO authenticated USING (tenant_id = auth_tenant_id());
CREATE POLICY tenant_insert_ingest_keys ON ingest_keys
  FOR INSERT TO authenticated WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_update_ingest_keys ON ingest_keys
  FOR UPDATE TO authenticated
  USING (tenant_id = auth_tenant_id()) WITH CHECK (tenant_id = auth_tenant_id());
CREATE POLICY tenant_delete_ingest_keys ON ingest_keys
  FOR DELETE TO authenticated USING (tenant_id = auth_tenant_id());

-- The push endpoint authenticates BEFORE it knows the tenant (see point 1
-- above), so it must look up ingest_keys as service_role, same as
-- tenant_invites redemption (00015) resolving a token before the redeemer
-- has a tenant claim.
CREATE POLICY service_all_ingest_keys ON ingest_keys
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
