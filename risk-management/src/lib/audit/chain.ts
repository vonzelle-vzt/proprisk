import { createAdminClient } from '@/lib/supabase/admin';
import { createHash } from 'crypto';
import { DEMO_MODE } from '@/lib/demo';

/**
 * Tamper-evident hash-chained audit logger (SHA-256 prev_hash/entry_hash),
 * writing to the append-only `audit_log` table.
 *
 * Originally lived at `src/lib/deductions/audit.ts`; relocated here so it can
 * be shared by any subsystem that needs a chained audit trail, not just
 * deductions — payout decisions (see `src/lib/audit/chain.ts` callers in the
 * payout-decision feature) log through the same chain. The old path
 * re-exports this module so existing imports keep working.
 */

/** Known action types. Not an exhaustive union — callers may pass any string;
 *  this list documents the event types the platform emits today plus the new
 *  ones added for explainable payout decisions. */
export type AuditActionType =
  | 'deduction_executed'
  | 'email_sent'
  | 'manual_email_sent'
  | 'cron_detect_violations'
  | 'cron_process_violations'
  | 'reviewer_run'
  | 'enforcement_decision'
  | 'fraud_investigation_update'
  | 'violation_detected'
  | 'payout_decision'
  // A per-violation decision record was PERSISTED (not merely rendered) —
  // see src/lib/reports/violation/build.ts. Logged after the
  // `violation_reports` insert lands, with the row id and content hash.
  | 'violation_report_generated'
  | (string & {});

interface AuditEventParams {
  action_type: AuditActionType;
  entity_type: string;
  entity_id: string;
  performed_by: string;
  details: Record<string, any>;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

function computeEntryHash(payload: {
  action_type: string;
  entity_type: string;
  entity_id: string;
  performed_by: string;
  details_json: Record<string, any>;
  prev_hash: string;
  created_at_iso: string;
}) {
  const canonical = JSON.stringify(sortValue(payload));
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Canonical serialization of just the `details` object — the exact substring
 * the full-payload hash embeds for `details_json`. Passed to the
 * `append_audit_event` RPC as `p_details_canonical` so the SQL rebuilds the
 * fixed-order envelope around a byte-identical nested object (same key
 * ordering, number formatting and string escaping as this TS path).
 */
function canonicalDetails(details: Record<string, any>): string {
  return JSON.stringify(sortValue(details));
}

/**
 * Append one entry to the tamper-evident audit chain.
 *
 * Structural demo chokepoint: in DEMO_MODE this no-ops (the public demo has
 * no writable database — `createAdminClient()` would throw). Callers can
 * always await this unconditionally without guarding on DEMO_MODE themselves.
 *
 * Returns the computed `entry_hash` on success (callers that need a durable
 * pointer back into the chain — e.g. `payout_decisions.audit_hash` — can
 * store it), or `null` when nothing was written (demo mode, or the fallback
 * insert path for schemas predating the hash columns).
 */
export async function logAuditEvent(params: AuditEventParams): Promise<string | null> {
  if (DEMO_MODE) {
    console.log('[audit] demo mode: skipping audit_log write', {
      action_type: params.action_type,
      entity_type: params.entity_type,
      entity_id: params.entity_id,
    });
    return null;
  }

  const supabase = createAdminClient();

  // Preferred path: atomic, serialized append via the DB function. It takes a
  // transaction-scoped advisory lock so concurrent writers can't fork the
  // chain (the read-latest-then-insert race the TS fallback below still has).
  // We pass the pre-canonicalized details so the SQL hashes byte-identically.
  const rpc = await supabase.rpc('append_audit_event', {
    p_action_type: params.action_type,
    p_entity_type: params.entity_type,
    p_entity_id: params.entity_id,
    p_performed_by: params.performed_by,
    p_details: params.details,
    p_details_canonical: canonicalDetails(params.details),
  });

  if (!rpc.error) {
    return (rpc.data as string | null) ?? null;
  }

  // PGRST202 = function not found in the schema cache: a legacy DB predating
  // migration 00013. Fall through to the documented TS-side hashing path.
  // Any other RPC error means the function ran and failed (e.g. a constraint
  // or DB error) — don't attempt a second insert via the fallback; surface it
  // as a no-write, matching the legacy insert-failure contract.
  if (rpc.error.code !== 'PGRST202') {
    console.error('Failed to log audit event (rpc):', rpc.error);
    return null;
  }

  const createdAtIso = new Date().toISOString();

  const { data: previous } = await supabase
    .from('audit_log')
    .select('entry_hash')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const prevHash = previous?.entry_hash || 'GENESIS';
  const entryHash = computeEntryHash({
    action_type: params.action_type,
    entity_type: params.entity_type,
    entity_id: params.entity_id,
    performed_by: params.performed_by,
    details_json: params.details,
    prev_hash: prevHash,
    created_at_iso: createdAtIso,
  });

  // Fallback insert supports older schemas before migration 00002.
  const { error } = await supabase
    .from('audit_log')
    .insert({
      action_type: params.action_type,
      entity_type: params.entity_type,
      entity_id: params.entity_id,
      performed_by: params.performed_by,
      details_json: params.details,
      prev_hash: prevHash,
      entry_hash: entryHash,
      created_at: createdAtIso,
    })
    .select('id')
    .maybeSingle();

  if (error) {
    const fallback = await supabase.from('audit_log').insert({
      action_type: params.action_type,
      entity_type: params.entity_type,
      entity_id: params.entity_id,
      performed_by: params.performed_by,
      details_json: params.details,
    });

    if (fallback.error) {
      console.error('Failed to log audit event:', fallback.error);
    }
    return null;
  }

  return entryHash;
}
