import { createHash } from 'crypto';
import { globalTable, tenantDb } from '@/lib/db/tenant-scoped';
import { parseRulePack, rulePackSchema, validateRulePack, type RulePack } from './schema';

/**
 * Rule pack persistence and the publishing workflow.
 *
 * Two invariants, both of which exist because a breach decision has to remain
 * explicable years later, in front of a trader disputing it:
 *
 *  1. A pack that has left `draft` is IMMUTABLE. Editing an active pack in
 *     place would silently rewrite the rules that past decisions were made
 *     under, so every change forks a new version instead.
 *
 *  2. A pack cannot reach `active` without a human approving it AND a
 *     shadow-mode backtest having been run. Nothing here can turn on rules
 *     nobody has looked at.
 *
 * The lifecycle is draft → testing → active → archived. `testing` is the state
 * a pack sits in while it is being backtested: it is real and evaluated, but
 * its decisions are recorded `enforced: false`.
 */

export type PackStatus = 'draft' | 'testing' | 'active' | 'archived';

export interface StoredRulePack {
  id: string;
  tenantId: string;
  name: string;
  assetClass: 'forex' | 'futures';
  version: number;
  status: PackStatus;
  pack: RulePack;
  contentHash: string;
  derivedFrom: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export class PackImmutableError extends Error {
  constructor(status: PackStatus) {
    super(
      `A rule pack in "${status}" cannot be edited. Past breach decisions were made under it, ` +
        `so changing it would rewrite history. Create a new version instead.`
    );
    this.name = 'PackImmutableError';
  }
}

export class PackValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Rule pack is not valid: ${errors.join(' ')}`);
    this.name = 'PackValidationError';
  }
}

/**
 * Content hash over the canonicalised pack.
 *
 * Keys are sorted so that two packs which mean the same thing hash the same
 * regardless of the order a UI happened to serialise them in — otherwise every
 * save would look like a change and version numbers would climb for nothing.
 */
export function contentHashOf(pack: RulePack): string {
  return createHash('sha256').update(canonicalise(pack)).digest('hex');
}

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`);

  return `{${entries.join(',')}}`;
}

function rowToPack(row: Record<string, unknown>): StoredRulePack {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    assetClass: row.asset_class as 'forex' | 'futures',
    version: Number(row.version),
    status: row.status as PackStatus,
    pack: row.pack_json as RulePack,
    contentHash: String(row.content_hash),
    derivedFrom: (row.derived_from as string) ?? null,
    approvedBy: (row.approved_by as string) ?? null,
    approvedAt: (row.approved_at as string) ?? null,
    createdAt: String(row.created_at),
  };
}

/**
 * Create a new draft. Validation happens here rather than at activation so a
 * firm finds out its pack is incoherent while it is still writing it.
 */
export async function createDraft(
  tenantId: string,
  input: { pack: unknown; derivedFrom?: string; createdBy?: string }
): Promise<StoredRulePack> {
  const parsed = rulePackSchema.parse(input.pack);
  const validation = validateRulePack(parsed);
  if (!validation.valid) throw new PackValidationError(validation.errors);

  const db = tenantDb(tenantId, 'createDraft');

  // Versions are per (tenant, name): editing "House Rules" produces v2 of the
  // same pack rather than an unrelated one, which is what makes the version
  // pinned on a breach decision meaningful.
  const { data: existing } = await db
    .select('rule_packs', 'version')
    .eq('name', parsed.name)
    .order('version', { ascending: false })
    .limit(1);

  const nextVersion = Array.isArray(existing) && existing.length > 0
    ? Number((existing[0] as unknown as { version: number }).version) + 1
    : 1;

  const { data, error } = await db
    .insert('rule_packs', {
      name: parsed.name,
      asset_class: parsed.asset_class,
      version: nextVersion,
      status: 'draft',
      schema_version: parsed.schema_version,
      pack_json: parsed,
      content_hash: contentHashOf(parsed),
      derived_from: input.derivedFrom ?? null,
      created_by: input.createdBy ?? null,
    })
    .select()
    .single();

  if (error) throw error;
  return rowToPack(data as Record<string, unknown>);
}

/** Edit a draft in place. Anything past draft is immutable — fork instead. */
export async function updateDraft(
  tenantId: string,
  packId: string,
  nextPack: unknown
): Promise<StoredRulePack> {
  const db = tenantDb(tenantId, 'updateDraft');

  const { data: current, error: readErr } = await db
    .from('rule_packs')
    .eq('id', packId)
    .single();
  if (readErr) throw readErr;

  const status = (current as { status: PackStatus }).status;
  if (status !== 'draft') throw new PackImmutableError(status);

  const { pack, validation } = parseRulePack(nextPack);
  if (!validation.valid) throw new PackValidationError(validation.errors);

  const { data, error } = await db
    .update('rule_packs', {
      name: pack.name,
      asset_class: pack.asset_class,
      pack_json: pack,
      content_hash: contentHashOf(pack),
      updated_at: new Date().toISOString(),
    })
    .eq('id', packId)
    .select()
    .single();

  if (error) throw error;
  return rowToPack(data as Record<string, unknown>);
}

/** Move a draft into testing, where it is evaluated but never enforces. */
export async function promoteToTesting(tenantId: string, packId: string): Promise<void> {
  const db = tenantDb(tenantId, 'promoteToTesting');
  const { error } = await db
    .update('rule_packs', { status: 'testing', updated_at: new Date().toISOString() })
    .eq('id', packId)
    .eq('status', 'draft');
  if (error) throw error;
}

export class ActivationBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ActivationBlockedError';
  }
}

/**
 * Record platform sign-off on a specific pack version.
 *
 * This is a PLATFORM-OPERATOR action, not a tenant one, and is deliberately not
 * reachable through any tenant-authenticated route. It exists so a firm can
 * self-serve the entire funnel — signup, credentials, presets, tuning, backtest
 * — while a human still reads the backtest reconciliation before that firm's
 * rules can terminate a real funded account.
 *
 * Sign-off is per pack VERSION rather than per tenant, because a firm
 * publishing v2 has written new rules; approving the firm once would approve
 * every rulebook they ever write.
 *
 * The backtest id is recorded alongside the approver: without it, "we reviewed
 * this" is an unfalsifiable claim at exactly the moment a trader disputes a
 * termination.
 */
export async function recordPlatformApproval(
  tenantId: string,
  packId: string,
  approval: { approvedBy: string; note?: string; backtestRunId?: string }
): Promise<void> {
  const db = tenantDb(tenantId, 'recordPlatformApproval');
  const { error } = await db
    .update('rule_packs', {
      platform_approved_by: approval.approvedBy,
      platform_approved_at: new Date().toISOString(),
      platform_approval_note: approval.note ?? null,
      platform_approved_backtest_id: approval.backtestRunId ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', packId);

  if (error) throw error;
}

/**
 * Activate a pack.
 *
 * Refuses unless a backtest has been run AND that backtest found no breach the
 * firm's own platform caught but this pack would have missed. Activating past
 * that would silently relax the firm's rules — the one failure mode a risk
 * platform must not have, and the reason the check lives here rather than being
 * left to whoever builds the UI.
 *
 * The previously active pack for the same asset class is archived in the same
 * operation; the database also carries a partial unique index enforcing at most
 * one active pack, so a race cannot produce two.
 */
export async function activate(
  tenantId: string,
  packId: string,
  approvedBy: string
): Promise<void> {
  const db = tenantDb(tenantId, 'activate');

  const { data: pack, error: readErr } = await db.from('rule_packs').eq('id', packId).single();
  if (readErr) throw readErr;
  const row = pack as unknown as {
    status: PackStatus;
    asset_class: string;
    platform_approved_at: string | null;
  };

  if (row.status === 'active') return;
  if (row.status === 'archived') {
    throw new ActivationBlockedError('An archived pack cannot be reactivated; create a new version.');
  }

  // The staged-launch gate. While a tenant is in supervised mode, a human at
  // the platform reads the backtest reconciliation before that firm's rules can
  // terminate a real account. The flag is read fresh here rather than cached:
  // this is the last checkpoint before enforcement, and it is worth a query.
  const { data: tenantRow, error: tenantErr } = await globalTable('tenants')
    .select('enforcement_approval_required')
    .eq('id', tenantId)
    .single();
  if (tenantErr) throw tenantErr;

  const gated = (tenantRow as unknown as { enforcement_approval_required: boolean } | null)
    ?.enforcement_approval_required;

  if (gated && !row.platform_approved_at) {
    throw new ActivationBlockedError(
      'This rule pack is awaiting platform review. Your backtest is complete and the pack is ' +
        'ready — we read the reconciliation before a new firm’s rules can act on live accounts. ' +
        'This is removed once your rulebook is established.'
    );
  }

  const { data: runs } = await db
    .select('backtest_runs', 'id, status, reconciliation_json, skipped_json')
    .eq('rule_pack_id', packId)
    .eq('status', 'complete')
    .order('created_at', { ascending: false })
    .limit(1);

  const latest = Array.isArray(runs) ? runs[0] : undefined;
  if (!latest) {
    throw new ActivationBlockedError(
      'This pack has not been backtested. Run a shadow-mode backtest against your own history before enforcing it.'
    );
  }

  const missed =
    ((latest as { reconciliation_json?: { providerOnly?: unknown[] } }).reconciliation_json
      ?.providerOnly ?? []).length;

  if (missed > 0) {
    throw new ActivationBlockedError(
      `The last backtest found ${missed} breach(es) your platform enforced that this pack would have missed. ` +
        `Activating it would relax your rules. Resolve those first.`
    );
  }

  // "No breach" and "not checked" must never read the same (HOW-IT-WORKS.md
  // §2, Flow 1): a run that could not evaluate every enabled rule proved
  // nothing about the rules it skipped, so it cannot certify the pack either.
  //
  // On an absent/malformed `skipped_json` we treat "unknown" as "unknown, not
  // clean" for a row that legitimately predates the field — but there is no
  // such row here: `backtest_runs.skipped_json` was defined NOT NULL DEFAULT
  // '[]' in the same migration (00018) that created the table, so nothing
  // written by real backtest runs can lack it. An absent field can therefore
  // only mean a stub/fixture that never populated it, which we read the same
  // way the column's own default reads it: as "nothing was skipped".
  const skippedField = (latest as { skipped_json?: unknown }).skipped_json;
  const skipped = Array.isArray(skippedField)
    ? (skippedField as Array<{ ruleId?: string; reason?: string }>)
    : [];

  if (skipped.length > 0) {
    const ruleIds = skipped.map((s) => s.ruleId).filter(Boolean);
    const firstReason = skipped[0]?.reason;
    throw new ActivationBlockedError(
      `The last backtest could not evaluate ${ruleIds.join(', ')}` +
        (firstReason ? ` (${firstReason})` : '') +
        `. A pack is only activatable once every enabled rule was checked.`
    );
  }

  // Archive the incumbent before promoting, so the partial unique index on
  // (tenant_id, asset_class) WHERE status = 'active' is never violated.
  const { error: archiveErr } = await db
    .update('rule_packs', { status: 'archived', updated_at: new Date().toISOString() })
    .eq('asset_class', row.asset_class)
    .eq('status', 'active');
  if (archiveErr) throw archiveErr;

  const { error } = await db
    .update('rule_packs', {
      status: 'active',
      approved_by: approvedBy,
      approved_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', packId);
  if (error) throw error;
}

/** The pack currently enforcing for a tenant and asset class, if any. */
export async function activePack(
  tenantId: string,
  assetClass: 'forex' | 'futures'
): Promise<StoredRulePack | null> {
  const { data, error } = await tenantDb(tenantId, 'activePack')
    .from('rule_packs')
    .eq('asset_class', assetClass)
    .eq('status', 'active')
    .maybeSingle();

  if (error) throw error;
  return data ? rowToPack(data as Record<string, unknown>) : null;
}

export async function listPacks(tenantId: string): Promise<StoredRulePack[]> {
  const { data, error } = await tenantDb(tenantId, 'listPacks')
    .from('rule_packs')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []).map((r: Record<string, unknown>) => rowToPack(r));
}

/** Stable identity for decisions: the pack version they were made under. */
export function packVersionKey(pack: StoredRulePack): string {
  return `${pack.id}:v${pack.version}`;
}
