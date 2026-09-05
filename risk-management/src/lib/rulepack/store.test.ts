import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The store is tested against a scripted query stub rather than a live
 * database: what matters here is the WORKFLOW — that an activated pack cannot
 * be edited, and that a pack cannot enforce without a clean backtest — not that
 * supabase-js can round-trip a row.
 */

type Row = Record<string, unknown>;

const state = {
  packs: [] as Row[],
  runs: [] as Row[],
  tenants: [] as Row[],
  updates: [] as Array<{ table: string; patch: Row; filters: Row }>,
};

function rowsFor(table: string): Row[] {
  if (table === 'rule_packs') return state.packs;
  if (table === 'tenants') return state.tenants;
  return state.runs;
}

function queryStub(table: string) {
  const filters: Row = {};
  let rows: Row[] = rowsFor(table);
  let pendingUpdate: Row | null = null;

  const chain: Record<string, unknown> = {
    eq(col: string, val: unknown) {
      filters[col] = val;
      rows = rows.filter((r) => r[col] === val);
      return chain;
    },
    order() {
      return chain;
    },
    limit(n: number) {
      rows = rows.slice(0, n);
      return Promise.resolve({ data: rows, error: null });
    },
    select() {
      return chain;
    },
    single() {
      if (pendingUpdate) state.updates.push({ table, patch: pendingUpdate, filters });
      return Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'not found' } });
    },
    maybeSingle() {
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    },
    then(resolve: (v: unknown) => unknown) {
      if (pendingUpdate) state.updates.push({ table, patch: pendingUpdate, filters });
      return Promise.resolve({ data: rows, error: null }).then(resolve);
    },
    __update(patch: Row) {
      pendingUpdate = patch;
      return chain;
    },
  };
  return chain;
}

vi.mock('@/lib/db/tenant-scoped', () => ({
  globalTable: (table: string) => queryStub(table),
  tenantDb: (tenantId: string) => ({
    tenantId,
    from: (table: string) => queryStub(table),
    select: (table: string) => queryStub(table),
    insert: (_table: string, row: Row) => {
      const stored = { id: 'pack-new', tenant_id: tenantId, created_at: '2026-03-01', ...row };
      state.packs.push(stored);
      return {
        select: () => ({ single: () => Promise.resolve({ data: stored, error: null }) }),
      };
    },
    update: (table: string, patch: Row) => (queryStub(table) as { __update: (p: Row) => unknown }).__update(patch),
  }),
}));

import {
  ActivationBlockedError,
  recordPlatformApproval,
  PackImmutableError,
  PackValidationError,
  activate,
  contentHashOf,
  createDraft,
  updateDraft,
} from './store';
import { presetById } from './presets';

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const ftmo = presetById('ftmo-style')!.pack;

beforeEach(() => {
  state.packs = [];
  state.runs = [];
  // Default: an established firm, not under supervision. Tests that exercise
  // the staged-launch gate opt into it explicitly.
  state.tenants = [{ id: TENANT, enforcement_approval_required: false }];
  state.updates = [];
});

/** A pack in testing with a clean backtest — everything but the gate satisfied. */
function readyToActivate() {
  state.packs.push({ id: 'p1', tenant_id: TENANT, status: 'testing', asset_class: 'forex' });
  state.runs.push({
    id: 'r1',
    rule_pack_id: 'p1',
    status: 'complete',
    reconciliation_json: { providerOnly: [] },
  });
}

function superviseTenant() {
  state.tenants = [{ id: TENANT, enforcement_approval_required: true }];
}

describe('content hashing is order-independent', () => {
  it('hashes two identically-meaning packs the same regardless of key order', () => {
    const a = { ...ftmo, rules: { drawdown: ftmo.rules.drawdown, daily_loss: ftmo.rules.daily_loss } };
    const b = { ...ftmo, rules: { daily_loss: ftmo.rules.daily_loss, drawdown: ftmo.rules.drawdown } };
    expect(contentHashOf(a as never)).toBe(contentHashOf(b as never));
  });

  it('hashes a genuine change differently', () => {
    const changed = structuredClone(ftmo);
    changed.rules.daily_loss!.threshold = { type: 'pct_of_initial', value: 0.04 };
    expect(contentHashOf(changed)).not.toBe(contentHashOf(ftmo));
  });
});

describe('drafts are validated on creation, not at activation', () => {
  it('refuses an incoherent pack immediately', async () => {
    const bad = structuredClone(ftmo);
    bad.rules.drawdown!.enabled = false;
    bad.rules.daily_loss!.enabled = false;

    await expect(createDraft(TENANT, { pack: bad })).rejects.toBeInstanceOf(PackValidationError);
  });

  it('accepts a valid preset and stores it as a draft at version 1', async () => {
    const created = await createDraft(TENANT, { pack: ftmo, derivedFrom: 'ftmo-style' });
    expect(created.status).toBe('draft');
    expect(created.version).toBe(1);
    expect(created.derivedFrom).toBe('ftmo-style');
  });
});

describe('a pack past draft is immutable', () => {
  it.each(['testing', 'active', 'archived'] as const)('refuses to edit a %s pack', async (status) => {
    state.packs.push({ id: 'p1', tenant_id: TENANT, status, asset_class: 'forex' });

    await expect(updateDraft(TENANT, 'p1', ftmo)).rejects.toBeInstanceOf(PackImmutableError);
  });

  it('explains WHY, because the caller has to fork instead', async () => {
    state.packs.push({ id: 'p1', tenant_id: TENANT, status: 'active', asset_class: 'forex' });
    await expect(updateDraft(TENANT, 'p1', ftmo)).rejects.toThrow(/rewrite history/i);
  });
});

describe('activation is gated on a clean backtest', () => {
  it('refuses a pack that has never been backtested', async () => {
    state.packs.push({ id: 'p1', tenant_id: TENANT, status: 'testing', asset_class: 'forex' });

    await expect(activate(TENANT, 'p1', 'dana@firm.com')).rejects.toBeInstanceOf(
      ActivationBlockedError
    );
    await expect(activate(TENANT, 'p1', 'dana@firm.com')).rejects.toThrow(/has not been backtested/i);
  });

  // The blocking case. Activating here would silently relax the firm's rules.
  it('refuses when the backtest missed a breach the platform enforced', async () => {
    state.packs.push({ id: 'p1', tenant_id: TENANT, status: 'testing', asset_class: 'forex' });
    state.runs.push({
      id: 'r1',
      rule_pack_id: 'p1',
      status: 'complete',
      reconciliation_json: { providerOnly: [{ accountId: 'a1', ruleId: 'daily_loss' }] },
    });

    await expect(activate(TENANT, 'p1', 'dana@firm.com')).rejects.toThrow(/would relax your rules/i);
  });

  // "No breach" and "not checked" must never read the same: a rule the
  // backtest could not evaluate proves nothing, so it must block just like a
  // missed breach does.
  it('refuses when the backtest could not evaluate one or more rules', async () => {
    state.packs.push({ id: 'p1', tenant_id: TENANT, status: 'testing', asset_class: 'forex' });
    state.runs.push({
      id: 'r1',
      rule_pack_id: 'p1',
      status: 'complete',
      reconciliation_json: { providerOnly: [] },
      skipped_json: [{ ruleId: 'drawdown', reason: 'needs intraday equity snapshots' }],
    });

    await expect(activate(TENANT, 'p1', 'dana@firm.com')).rejects.toBeInstanceOf(
      ActivationBlockedError
    );
    await expect(activate(TENANT, 'p1', 'dana@firm.com')).rejects.toThrow(/drawdown/);
  });

  it('activates when the backtest missed nothing, recording the approver', async () => {
    state.packs.push({ id: 'p1', tenant_id: TENANT, status: 'testing', asset_class: 'forex' });
    state.runs.push({
      id: 'r1',
      rule_pack_id: 'p1',
      status: 'complete',
      reconciliation_json: { providerOnly: [] },
      skipped_json: [],
    });

    await activate(TENANT, 'p1', 'dana@firm.com');

    const activation = state.updates.find((u) => u.patch.status === 'active');
    expect(activation).toBeDefined();
    expect(activation!.patch.approved_by).toBe('dana@firm.com');
  });

  it('archives the incumbent before promoting, so two packs are never active', async () => {
    state.packs.push({ id: 'p1', tenant_id: TENANT, status: 'testing', asset_class: 'forex' });
    state.runs.push({
      id: 'r1',
      rule_pack_id: 'p1',
      status: 'complete',
      reconciliation_json: { providerOnly: [] },
    });

    await activate(TENANT, 'p1', 'dana@firm.com');

    const archiveIndex = state.updates.findIndex((u) => u.patch.status === 'archived');
    const activateIndex = state.updates.findIndex((u) => u.patch.status === 'active');
    expect(archiveIndex).toBeGreaterThanOrEqual(0);
    expect(archiveIndex).toBeLessThan(activateIndex);
  });

  it('refuses to reactivate an archived pack', async () => {
    state.packs.push({ id: 'p1', tenant_id: TENANT, status: 'archived', asset_class: 'forex' });
    await expect(activate(TENANT, 'p1', 'dana@firm.com')).rejects.toThrow(/cannot be reactivated/i);
  });

  it('is a no-op for a pack that is already active', async () => {
    state.packs.push({ id: 'p1', tenant_id: TENANT, status: 'active', asset_class: 'forex' });
    await expect(activate(TENANT, 'p1', 'dana@firm.com')).resolves.toBeUndefined();
    expect(state.updates).toEqual([]);
  });
});

/**
 * The staged-launch gate. A firm self-serves the whole funnel; the single
 * moment that can end a real trader's account is held until a human at the
 * platform has read the backtest reconciliation.
 */
describe('platform enforcement approval', () => {
  it('blocks activation for a supervised tenant with no sign-off', async () => {
    superviseTenant();
    readyToActivate();

    await expect(activate(TENANT, 'p1', 'dana@firm.com')).rejects.toBeInstanceOf(
      ActivationBlockedError
    );
    await expect(activate(TENANT, 'p1', 'dana@firm.com')).rejects.toThrow(/awaiting platform review/i);
  });

  // The message a customer reads when they are blocked. They have done nothing
  // wrong and their pack is correct, so it should not read as a failure.
  it('explains the hold without implying the firm made a mistake', async () => {
    superviseTenant();
    readyToActivate();

    await expect(activate(TENANT, 'p1', 'dana@firm.com')).rejects.toThrow(
      /backtest is complete and the pack is ready/i
    );
  });

  it('allows activation once sign-off is recorded', async () => {
    superviseTenant();
    readyToActivate();
    state.packs[0].platform_approved_at = '2026-08-05T00:00:00Z';

    await activate(TENANT, 'p1', 'dana@firm.com');
    expect(state.updates.some((u) => u.patch.status === 'active')).toBe(true);
  });

  it('does not gate a tenant that is no longer supervised', async () => {
    readyToActivate(); // tenant defaults to enforcement_approval_required: false

    await activate(TENANT, 'p1', 'dana@firm.com');
    expect(state.updates.some((u) => u.patch.status === 'active')).toBe(true);
  });

  // The gate is additional to the backtest, never a substitute for it. A signed
  // pack that misses a breach the firm's own platform caught must still fail.
  it('does not let sign-off override a failing backtest', async () => {
    superviseTenant();
    state.packs.push({
      id: 'p1',
      tenant_id: TENANT,
      status: 'testing',
      asset_class: 'forex',
      platform_approved_at: '2026-08-05T00:00:00Z',
    });
    state.runs.push({
      id: 'r1',
      rule_pack_id: 'p1',
      status: 'complete',
      reconciliation_json: { providerOnly: [{ accountId: 'a1', ruleId: 'daily_loss' }] },
    });

    await expect(activate(TENANT, 'p1', 'dana@firm.com')).rejects.toThrow(/would relax your rules/i);
  });

  it('records the reviewer and the backtest they actually read', async () => {
    state.packs.push({ id: 'p1', tenant_id: TENANT, status: 'testing', asset_class: 'forex' });

    await recordPlatformApproval(TENANT, 'p1', {
      approvedBy: 'ops@example.com',
      note: 'Matches their published rulebook; EOD trailing confirmed.',
      backtestRunId: '11111111-1111-1111-1111-111111111111',
    });

    const patch = state.updates.find((u) => u.patch.platform_approved_by)?.patch;
    expect(patch).toMatchObject({
      platform_approved_by: 'ops@example.com',
      platform_approved_backtest_id: '11111111-1111-1111-1111-111111111111',
    });
    expect(patch!.platform_approved_at).toBeTruthy();
  });
});
