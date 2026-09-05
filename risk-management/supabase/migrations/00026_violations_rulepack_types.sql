-- Rule-pack breaches need a violations row.
--
-- The detection cron now runs the rule-pack engine live (src/lib/rulepack/live.ts)
-- and every breach it emits has to leave a decision record that can be reported
-- on: a `breach_decisions` row for the arithmetic, and a `violations` row that
-- the evidence pack, the enforcement queue and the deduction path already key
-- off. Two things in the current schema stop that.
--
-- 1. `violations.violation_type` is the `violation_type` ENUM, whose seven
--    values are the legacy forex detectors ('2_percent_cap', 'overleveraging',
--    'hft', 'martingale', 'news', 'grid', 'copy'). A rule-pack breach is
--    identified by its RULE ID (the 13 ids in RULE_IDS, src/lib/rulepack/schema.ts),
--    and ten of those are not in the enum — inserting one fails, which would
--    mean a real breach with no decision record behind it.
--
--    Widening happens on the COLUMN, not on the shared enum type: the enum is
--    also the type of `violation_config.violation_type`, which configures the
--    legacy detectors only. Adding rule ids there would advertise configuration
--    that does not exist. So the column becomes TEXT with a CHECK over the
--    union, and the enum type is left exactly as it is for violation_config.
--
-- 2. The rule-pack path must be idempotent by INPUT, not by clock — re-running
--    detection over an unchanged trade tape has to be a no-op. The engine's
--    `idempotencyKey` (sha256 over pack version + account + rule + measured
--    inputs) is stored in `details_json`, and the partial unique index below
--    makes "one violation per decision" a database guarantee rather than a
--    check-then-insert race between two cron invocations.
--
-- Nothing else about the table changes: RLS, its tenancy policies from 00015,
-- the FK to `accounts`, and every other column and index are untouched.

-- ---------------------------------------------------------------------------
-- 1. violation_type: enum -> text + widened CHECK
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'violations'
      AND column_name = 'violation_type'
      AND udt_name = 'violation_type'
  ) THEN
    ALTER TABLE violations
      ALTER COLUMN violation_type TYPE TEXT USING violation_type::TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'violations_violation_type_check'
  ) THEN
    ALTER TABLE violations
      ADD CONSTRAINT violations_violation_type_check CHECK (violation_type IN (
        -- The legacy detector vocabulary (unchanged; these still arrive from
        -- src/lib/payouts/local-analysis.ts).
        '2_percent_cap',
        'overleveraging',
        'hft',
        'martingale',
        'news',
        'grid',
        'copy',
        -- RULE_IDS, src/lib/rulepack/schema.ts. 'hft', 'martingale', 'news' and
        -- 'grid' are shared with the list above and are not repeated.
        'daily_loss',
        'drawdown',
        'consistency',
        'min_trading_days',
        'inactivity',
        'position_limit',
        'overnight_holding',
        'weekend_holding',
        'copy_trading'
      ));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. One violation per decision
-- ---------------------------------------------------------------------------
-- The predicate is on the KEY, not on the engine: the rule-pack path keys on
-- the evaluator's `idempotencyKey`, and the legacy detector path keys on a hash
-- of (account, type, flagged trade ids, amount) — see `legacyFindingKey` in
-- src/lib/violations/record.ts. Both are functions of their inputs, so an
-- unchanged tape re-detected is the same key and lands here as a no-op.
--
-- Rows written before this migration, and any future writer that records no
-- key, are left unconstrained rather than being forced to invent one.
--
-- Scoped to tenant_id because a key is only unique within the pack version (or
-- account book) that produced it, and both are per tenant.

CREATE UNIQUE INDEX IF NOT EXISTS uq_violations_idempotency
  ON violations (tenant_id, (details_json ->> 'idempotency_key'))
  WHERE details_json ->> 'idempotency_key' IS NOT NULL;

COMMENT ON INDEX uq_violations_idempotency IS
  'Detection is idempotent by input, not by clock: re-running the cron over an unchanged trade tape must not create a second violation for the same finding.';
