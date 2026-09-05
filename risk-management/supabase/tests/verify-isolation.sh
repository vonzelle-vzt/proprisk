#!/bin/zsh
# Rebuild a fresh DB from the whole migration chain, then prove isolation.
set -e
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
cd "$(dirname "$0")/../.."
PSQL() { psql -h 127.0.0.1 -p 55432 -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

PSQL -c "DROP DATABASE IF EXISTS rmp;" -c "CREATE DATABASE rmp;" >/dev/null 2>&1

PSQL -d rmp >/dev/null <<'SQL'
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- Roles are cluster-wide, so they survive DROP DATABASE.
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $r$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'sub','')::uuid $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('request.jwt.claims', true)::jsonb, '{}'::jsonb) $$;

-- Model Supabase's grant behaviour: tables get their privileges AT CREATION,
-- via default privileges. Granting after the migrations instead would silently
-- re-grant anything a migration deliberately REVOKED — which is how this
-- harness first reported a column-privilege fix as ineffective when the fix
-- was fine and the harness was wrong.
GRANT USAGE ON SCHEMA public TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
SQL

# The whole chain, in sorted order, exactly as a fresh install applies it.
# There is no baseline special case any more: 00001_baseline_schema.sql IS the
# first migration, and the numbers 00002-00014 are deliberately unused.
# Applying the same files a real deployment applies is the point — a harness
# that builds its database a different way can only prove things about itself.
#
# stderr is NOT swallowed. The baseline used to be applied with 2>&1 >/dev/null,
# which meant a migration could fail in a way nobody saw.
#
# Post-tenancy files are still COUNTED, and the count is still floored below.
# The number is PARSED rather than matched with a glob, because a pattern like
# 000[1-9][5-9] looks right and silently skips 00020, applying fewer migrations
# than intended while still reporting success — which is exactly how this
# harness once reported a working column-privilege fix as broken.
MIN_POST_TENANCY=10   # 00015..00024 today; raise this only when files are ADDED
applied=0
post=0
for m in $(ls supabase/migrations/*.sql | sort); do
  PSQL -d rmp -f "$m" >/dev/null
  echo "  applied $(basename "$m")"
  applied=$((applied + 1))
  n=$(basename "$m" | sed -E 's/^0*([0-9]+)_.*/\1/')
  [ "$n" -ge 15 ] && post=$((post + 1))
done
if [ "$applied" -lt 1 ]; then
  echo "FAIL: no migrations were applied — is supabase/migrations/ empty?" >&2
  exit 1
fi
if [ "$post" -lt "$MIN_POST_TENANCY" ]; then
  echo "FAIL: only $post post-tenancy migrations applied, expected at least $MIN_POST_TENANCY." >&2
  echo "      Every isolation policy this test asserts is created at 00015 or later," >&2
  echo "      so a short chain would let this test pass by checking nothing." >&2
  exit 1
fi
echo "migrations applied ($applied total, $post post-tenancy)"

PSQL -d rmp -t <<'SQL'
INSERT INTO tenants (id, name, slug) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','Firm A','firm-a'),
  ('bbbbbbbb-0000-0000-0000-000000000002','Firm B','firm-b');

-- SAME provider login on both firms: the collision the old constraint caused.
INSERT INTO accounts (tenant_id, login, user_profile_id, account_size, challenge_type, phase, email, trader_name)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','1001','pa',100000,'pro','funded','a@a.com','A Trader'),
       ('bbbbbbbb-0000-0000-0000-000000000002','1001','pb', 50000,'pro','funded','b@b.com','B Trader');
\echo 'PASS: both firms can hold account login 1001'

SET ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"tenant_id":"aaaaaaaa-0000-0000-0000-000000000001","role":"admin"}}', false);

DO $$
DECLARE n INT; e TEXT;
BEGIN
  SELECT count(*) INTO n FROM accounts;
  IF n <> 1 THEN RAISE EXCEPTION 'LEAK: Firm A sees % account rows, expected 1', n; END IF;
  RAISE NOTICE 'PASS: Firm A sees exactly its own 1 account';

  SELECT email INTO e FROM accounts;
  IF e <> 'a@a.com' THEN RAISE EXCEPTION 'LEAK: Firm A sees %', e; END IF;
  RAISE NOTICE 'PASS: the row it sees is its own';

  SELECT count(*) INTO n FROM accounts WHERE tenant_id='bbbbbbbb-0000-0000-0000-000000000002';
  IF n <> 0 THEN RAISE EXCEPTION 'LEAK: Firm B rows reachable by explicit id'; END IF;
  RAISE NOTICE 'PASS: naming Firm B explicitly returns nothing';
END $$;

DO $$
BEGIN
  INSERT INTO accounts (tenant_id, login, user_profile_id, account_size, challenge_type, phase, email, trader_name)
  VALUES ('bbbbbbbb-0000-0000-0000-000000000002','EVIL','px',100000,'pro','funded','x@x.com','X');
  RAISE EXCEPTION 'LEAK: cross-tenant INSERT succeeded';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: cross-tenant INSERT refused by WITH CHECK';
END $$;

DO $$
DECLARE n INT;
BEGIN
  UPDATE accounts SET tenant_id='bbbbbbbb-0000-0000-0000-000000000002' WHERE login='1001';
  RAISE EXCEPTION 'LEAK: moved own row into another tenant';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: cross-tenant UPDATE refused by WITH CHECK';
END $$;

DO $$
DECLARE n INT;
BEGIN
  DELETE FROM accounts WHERE tenant_id='bbbbbbbb-0000-0000-0000-000000000002';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'LEAK: deleted % rows of another tenant', n; END IF;
  RAISE NOTICE 'PASS: cross-tenant DELETE affected 0 rows';
END $$;

-- A token carrying no tenant claim must be inert, not privileged.
SELECT set_config('request.jwt.claims','{"sub":"99999999-9999-9999-9999-999999999999","app_metadata":{"role":"admin"}}', false);
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM accounts;
  IF n <> 0 THEN RAISE EXCEPTION 'LEAK: claimless token saw % rows', n; END IF;
  RAISE NOTICE 'PASS: token with no tenant claim sees nothing (fails closed)';
END $$;

-- A forged claim naming a tenant the user is not a member of still passes RLS
-- (RLS trusts the JWT); this is why the claim is only ever minted server-side
-- from tenant_members. Documented, tested at the application layer.
RESET ROLE;
SQL

echo "--- a firm must not be able to rewrite its own commercial terms ---"
PSQL -d rmp -t <<'SQL'
SET ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"tenant_id":"aaaaaaaa-0000-0000-0000-000000000001","role":"owner"}}', false);

-- RLS decides WHICH ROWS may be written, never WHICH COLUMNS. The
-- tenant_update_self policy lets an owner write its own tenant row, so without
-- column privileges a firm's own admin could upgrade its plan, lift its account
-- ceiling, un-cancel itself, or switch off the enforcement gate. Owner is the
-- highest role a customer can hold, so this is the strongest case available.
DO $$ BEGIN
  UPDATE tenants SET name = 'Renamed By Owner' WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
  RAISE NOTICE 'PASS: a firm can still rename and rebrand itself';
END $$;

DO $$
DECLARE col TEXT;
BEGIN
  FOREACH col IN ARRAY ARRAY[
    'plan_tier', 'status', 'max_accounts', 'enforcement_approval_required'
  ] LOOP
    BEGIN
      EXECUTE format(
        'UPDATE tenants SET %I = %L WHERE id = %L',
        col,
        CASE col
          WHEN 'plan_tier' THEN 'enterprise'
          WHEN 'status' THEN 'active'
          WHEN 'max_accounts' THEN '999999'
          ELSE 'false'
        END,
        'aaaaaaaa-0000-0000-0000-000000000001'
      );
      RAISE EXCEPTION 'HOLE: a firm rewrote its own %', col;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS: cannot write its own %', col;
    END;
  END LOOP;
END $$;
RESET ROLE;
SQL

echo "--- every tenant-scoped table must carry tenant_id + 4 policies ---"
PSQL -d rmp -t <<'SQL'
DO $$
DECLARE r RECORD; missing TEXT := '';
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
      AND c.relname NOT IN ('tenants','tenant_members','tenant_invites','news_events')
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name=r.relname AND column_name='tenant_id')
    THEN missing := missing || r.relname || ' (no tenant_id) '; END IF;

    IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename=r.relname) < 5
    THEN missing := missing || r.relname || ' (policies<5) '; END IF;

    IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=r.relname::regclass)
    THEN missing := missing || r.relname || ' (RLS not forced) '; END IF;
  END LOOP;

  IF missing <> '' THEN RAISE EXCEPTION 'INCOMPLETE: %', missing; END IF;
  RAISE NOTICE 'PASS: all tenant-scoped tables have tenant_id, forced RLS, and 5 policies';
END $$;

-- A policy is unconstrained if the expression that actually governs it is
-- absent or literally true. For INSERT that expression is WITH CHECK (qual is
-- always NULL there); for every other command it is USING.
DO $$
DECLARE n INT; bad TEXT;
BEGIN
  SELECT count(*), string_agg(tablename || '.' || policyname, ', ')
    INTO n, bad
  FROM pg_policies
  WHERE schemaname='public'
    AND 'authenticated' = ANY(roles)
    AND tablename <> 'news_events'
    AND CASE WHEN cmd = 'INSERT'
             THEN (with_check IS NULL OR with_check = 'true')
             ELSE (qual IS NULL OR qual = 'true')
        END;
  IF n <> 0 THEN RAISE EXCEPTION 'LEAK: % unconstrained policies for authenticated: %', n, bad; END IF;
  RAISE NOTICE 'PASS: no unconstrained authenticated policy remains';
END $$;

-- And every remaining authenticated policy must actually mention tenant_id.
DO $$
DECLARE n INT; bad TEXT;
BEGIN
  SELECT count(*), string_agg(tablename || '.' || policyname, ', ')
    INTO n, bad
  FROM pg_policies
  WHERE schemaname='public'
    AND 'authenticated' = ANY(roles)
    AND tablename NOT IN ('news_events','tenants')
    AND COALESCE(qual,'') || COALESCE(with_check,'') NOT LIKE '%tenant_id%';
  IF n <> 0 THEN RAISE EXCEPTION 'LEAK: % policies do not reference tenant_id: %', n, bad; END IF;
  RAISE NOTICE 'PASS: every authenticated policy is scoped by tenant_id';
END $$;
SQL
echo "ISOLATION CHECK COMPLETE"
