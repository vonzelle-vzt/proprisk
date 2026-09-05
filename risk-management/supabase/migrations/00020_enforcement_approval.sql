-- 00020_enforcement_approval.sql
--
-- The staged-launch gate, and a column-privilege fix it exposed.
--
-- A firm can self-serve the entire funnel — sign up, connect its platform,
-- pick a preset, tune it, run a shadow-mode backtest — with no risk, because
-- none of that enforces anything. Exactly one moment is dangerous: flipping a
-- rule pack to `active`, after which it can terminate real funded accounts.
--
-- `activate()` already refuses without a clean backtest. For the first cohort
-- of customers we want a second condition: a platform operator has read that
-- backtest's reconciliation before the pack can end anyone's account. That is a
-- few minutes reading a machine-generated diff, not an onboarding call, and it
-- is removable per tenant once the presets stop producing surprises.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The gate
-- ---------------------------------------------------------------------------

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS enforcement_approval_required BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN tenants.enforcement_approval_required IS
  'While true, a rule pack additionally needs platform sign-off before it can '
  'enforce. Defaults TRUE so a tenant created by a future code path that has '
  'never heard of this column is gated rather than ungated.';

-- Sign-off is recorded against the PACK VERSION, not the tenant, because that
-- is the unit that was reviewed. A firm publishing v2 has written new rules
-- that can terminate accounts, so v2 is reviewed on its own merits.
ALTER TABLE rule_packs
  ADD COLUMN IF NOT EXISTS platform_approved_by TEXT,
  ADD COLUMN IF NOT EXISTS platform_approved_at TIMESTAMPTZ,
  -- What the reviewer actually saw. Without this, a sign-off six months ago is
  -- an unfalsifiable claim at the moment a trader disputes a termination.
  ADD COLUMN IF NOT EXISTS platform_approval_note TEXT,
  ADD COLUMN IF NOT EXISTS platform_approved_backtest_id UUID;

-- The seed tenant is the pre-existing single-tenant deployment, already
-- operating under rules its owner wrote. Gating it would be theatre.
UPDATE tenants
   SET enforcement_approval_required = false
 WHERE id = '00000000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- 2. Column privileges on `tenants`
-- ---------------------------------------------------------------------------
--
-- A gap this migration exposed in 00015, and the reason the flag above is not
-- safe without it.
--
-- 00015's `tenant_update_self` policy lets an owner|admin UPDATE their own
-- tenant row, and its comment asserts that "plan_tier and status are set by
-- billing through service_role, never by the customer". The policy does not
-- enforce that. RLS is ROW-level: it decides WHICH rows you may write, never
-- WHICH COLUMNS. So a firm's own admin could set their own `plan_tier` to
-- enterprise, lift their own `max_accounts`, reactivate a `cancelled` tenant —
-- and, once this migration lands, clear their own enforcement gate.
--
-- Column-level privileges are the mechanism RLS lacks. Allowlisted rather than
-- denylisted: a column added later is NOT customer-writable by default, so the
-- next person to add `billing_override` does not have to remember this file.
REVOKE UPDATE ON tenants FROM authenticated;
GRANT UPDATE (name, branding_json) ON tenants TO authenticated;

-- service_role is unaffected: billing and platform operations legitimately
-- write plan_tier, status, max_accounts and the gate.

COMMIT;
