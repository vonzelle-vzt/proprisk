import { beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

/** In-memory `connections` table, keyed by tenant_id+provider_id like the real UNIQUE constraint. */
let rows: Record<string, unknown>[] = [];

/**
 * A lazy builder over an in-memory row set: `.eq()` accumulates filters and
 * is chainable any number of times (tenantDb applies one `eq('tenant_id', …)`
 * internally, then callers add their own on top); the actual filter/mutate
 * only runs when the query is finally awaited or a terminal method is called.
 */
function makeBuilder(
  table: string,
  opts: { mutate?: (matched: Record<string, unknown>[]) => void; onDelete?: boolean } = {}
) {
  const filters: Array<[string, unknown]> = [];
  const resolve = () => {
    let matched = rows.filter((r) => r._table === table);
    for (const [col, val] of filters) matched = matched.filter((r) => r[col] === val);
    if (opts.onDelete) {
      const keep = new Set(matched);
      rows = rows.filter((r) => !keep.has(r));
    } else if (opts.mutate) {
      opts.mutate(matched);
    }
    return matched;
  };

  const builder: any = {
    eq(col: string, val: unknown) {
      filters.push([col, val]);
      return builder;
    },
    order() {
      return builder;
    },
    select() {
      return builder;
    },
    async maybeSingle() {
      const matched = resolve();
      return { data: matched[0] ?? null, error: null };
    },
    async single() {
      const matched = resolve();
      return { data: matched[0] ?? null, error: null };
    },
    then(onResolve: (v: { data: unknown; error: null }) => void) {
      const matched = resolve();
      return onResolve({ data: matched, error: null });
    },
  };
  return builder;
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => makeBuilder(table),
      insert: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
        const arr = Array.isArray(payload) ? payload : [payload];
        const inserted = arr.map((p) => ({ ...p, _table: table, id: p.id || `id-${rows.length}-${Math.random()}` }));
        rows.push(...inserted);
        return makeBuilder(table);
      },
      upsert: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
        const arr = Array.isArray(payload) ? payload : [payload];
        for (const p of arr) {
          const idx = rows.findIndex(
            (r) => r._table === table && r.tenant_id === p.tenant_id && r.provider_id === p.provider_id
          );
          if (idx >= 0) rows[idx] = { ...rows[idx], ...p, _table: table };
          else rows.push({ ...p, _table: table, id: `id-${rows.length}-${Math.random()}` });
        }
        return makeBuilder(table);
      },
      update: (patch: Record<string, unknown>) =>
        makeBuilder(table, { mutate: (matched) => matched.forEach((r) => Object.assign(r, patch)) }),
      delete: () => makeBuilder(table, { onDelete: true }),
    }),
  }),
}));

beforeEach(() => {
  rows = [];
  process.env.CONNECTIONS_MASTER_KEY = Buffer.alloc(32, 3).toString('base64');
});

import {
  deleteConnection,
  getConnection,
  getDecryptedConfig,
  listConnections,
  recordValidationResult,
  upsertConnection,
} from './store';

describe('connections store', () => {
  it('upsertConnection encrypts secrets and getConnection never exposes them', async () => {
    await upsertConnection(TENANT_A, 'tradovate', {
      assetClass: 'futures',
      enabled: true,
      apiUrl: 'https://demo.tradovateapi.com/v1',
      secrets: { NAME: 'trader1', PASSWORD: 'hunter2' },
      actor: 'owner@firm.com',
    });

    const conn = await getConnection(TENANT_A, 'tradovate');
    expect(conn).not.toBeNull();
    expect(conn!.enabled).toBe(true);
    expect(JSON.stringify(conn)).not.toContain('hunter2');
    expect(conn!.secretsPreview.PASSWORD).toMatch(/\*+ter2$/);
  });

  it('getDecryptedConfig returns the real secrets for the adapter layer', async () => {
    await upsertConnection(TENANT_A, 'matchtrader', {
      assetClass: 'forex',
      enabled: true,
      secrets: { apiKey: 'raw-token-value', SYSTEM_UUID: 'sys-1' },
      actor: 'owner@firm.com',
    });

    const cfg = await getDecryptedConfig(TENANT_A, 'matchtrader');
    expect(cfg?.secrets.apiKey).toBe('raw-token-value');
    expect(cfg?.secrets.SYSTEM_UUID).toBe('sys-1');
  });

  it('a second upsert merges onto existing secrets instead of wiping them', async () => {
    await upsertConnection(TENANT_A, 'tradovate', {
      assetClass: 'futures',
      enabled: true,
      secrets: { NAME: 'trader1', PASSWORD: 'hunter2' },
      actor: 'a',
    });
    await upsertConnection(TENANT_A, 'tradovate', {
      assetClass: 'futures',
      enabled: true,
      secrets: { PASSWORD: 'newpass' },
      actor: 'a',
    });

    const cfg = await getDecryptedConfig(TENANT_A, 'tradovate');
    expect(cfg?.secrets.NAME).toBe('trader1');
    expect(cfg?.secrets.PASSWORD).toBe('newpass');
  });

  it('tenant B has no visibility into tenant A connections', async () => {
    await upsertConnection(TENANT_A, 'tradovate', {
      assetClass: 'futures',
      enabled: true,
      secrets: { NAME: 'trader1' },
      actor: 'a',
    });

    expect(await getConnection(TENANT_B, 'tradovate')).toBeNull();
    expect(await listConnections(TENANT_B)).toEqual([]);
  });

  it('recordValidationResult sets status/last_error without touching secrets', async () => {
    await upsertConnection(TENANT_A, 'tradovate', {
      assetClass: 'futures',
      enabled: true,
      secrets: { NAME: 'trader1' },
      actor: 'a',
    });
    await recordValidationResult(TENANT_A, 'tradovate', { ok: false, error: 'auth failed' });

    const conn = await getConnection(TENANT_A, 'tradovate');
    expect(conn?.status).toBe('invalid');
    expect(conn?.lastError).toBe('auth failed');
  });

  it('deleteConnection removes the row', async () => {
    await upsertConnection(TENANT_A, 'tradovate', {
      assetClass: 'futures',
      enabled: true,
      secrets: { NAME: 'trader1' },
      actor: 'a',
    });
    await deleteConnection(TENANT_A, 'tradovate');
    expect(await getConnection(TENANT_A, 'tradovate')).toBeNull();
  });
});
