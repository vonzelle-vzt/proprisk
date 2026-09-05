import { beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';

let rows: Record<string, unknown>[] = [];

function makeBuilder(table: string, opts: { mutate?: (matched: Record<string, unknown>[]) => void } = {}) {
  const filters: Array<[string, unknown]> = [];
  const resolve = () => {
    let matched = rows.filter((r) => r._table === table);
    for (const [col, val] of filters) matched = matched.filter((r) => r[col] === val);
    if (opts.mutate) opts.mutate(matched);
    return matched;
  };
  const builder: any = {
    eq(col: string, val: unknown) {
      filters.push([col, val]);
      return builder;
    },
    select() {
      return builder;
    },
    async single() {
      const matched = resolve();
      return { data: matched[0] ?? null, error: matched[0] ? null : new Error('not found') };
    },
    async maybeSingle() {
      const matched = resolve();
      return { data: matched[0] ?? null, error: null };
    },
    then(onResolve: (v: { data: unknown; error: null }) => void) {
      return onResolve({ data: resolve(), error: null });
    },
  };
  return builder;
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => makeBuilder(table),
      insert: (payload: Record<string, unknown>) => {
        const row = { ...payload, _table: table, id: `id-${rows.length}` };
        rows.push(row);
        return makeBuilder(table);
      },
      update: (patch: Record<string, unknown>) =>
        makeBuilder(table, { mutate: (matched) => matched.forEach((r) => Object.assign(r, patch)) }),
    }),
  }),
}));

beforeEach(() => {
  rows = [];
});

import { createIngestKey, verifyIngestKey } from './keys';

describe('ingest keys', () => {
  it('mints a key that verifies to the issuing tenant', async () => {
    const created = await createIngestKey({ tenantId: TENANT_A, label: 'bridge-1', createdBy: 'owner@firm.com' });
    expect(created.key).toMatch(/^isk_[0-9a-f]{64}$/);

    const verified = await verifyIngestKey(created.key);
    expect(verified?.tenantId).toBe(TENANT_A);
  });

  it('rejects a key that was never issued', async () => {
    expect(await verifyIngestKey('isk_not-a-real-key')).toBeNull();
  });

  it('rejects a revoked key', async () => {
    const created = await createIngestKey({ tenantId: TENANT_A, createdBy: 'owner@firm.com' });
    rows.find((r) => r._table === 'ingest_keys')!.revoked_at = new Date().toISOString();

    expect(await verifyIngestKey(created.key)).toBeNull();
  });

  it('rejects empty/malformed input without throwing', async () => {
    expect(await verifyIngestKey('')).toBeNull();
  });
});
