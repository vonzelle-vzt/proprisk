import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A recording stub for the supabase-js admin client, in the same spirit as
 * src/lib/db/tenant-scoped.test.ts: each terminal call records what it was
 * asked to do so tests assert on the *shape* of the request, not a live
 * database. `tenants.eq('slug', ...)` is tracked specially so the collision
 * suite can simulate "this slug is already taken".
 */
let mockState: { client: unknown; calls: Array<Record<string, unknown>> };

function makeAdminClientMock(
  opts: {
    takenSlugs?: Set<string>;
    createUserResult?: { data: { user: { id: string } } | null; error: Error | null };
    tenantInsertId?: string;
  } = {}
) {
  const calls: Array<Record<string, unknown>> = [];
  const takenSlugs = opts.takenSlugs ?? new Set<string>();
  let lastSlugQueried: string | undefined;

  function builder(table: string) {
    const b: Record<string, unknown> = {};
    const record = (op: string, payload?: unknown) => {
      calls.push({ table, op, payload });
      return b;
    };
    b.select = (cols?: unknown) => record('select', cols);
    b.insert = (rows: unknown) => record('insert', rows);
    b.delete = () => record('delete');
    b.eq = (col: string, val: unknown) => {
      if (table === 'tenants' && col === 'slug') lastSlugQueried = val as string;
      return record('eq', { col, val });
    };
    b.maybeSingle = () => {
      if (table === 'tenants') {
        const taken = lastSlugQueried !== undefined && takenSlugs.has(lastSlugQueried);
        return Promise.resolve({ data: taken ? { id: 'existing-tenant' } : null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    b.single = () => {
      if (table === 'tenants') {
        return Promise.resolve({ data: { id: opts.tenantInsertId ?? 'tenant-new' }, error: null });
      }
      return Promise.resolve({ data: { id: 'row-id' }, error: null });
    };
    // Bare `await sb.from(table).insert(...)` / `.delete().eq(...)` with no
    // further chain — resolves like a successful mutation by default.
    b.then = (resolve: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(resolve);
    return b;
  }

  return {
    calls,
    client: {
      from: (table: string) => builder(table),
      auth: {
        admin: {
          createUser: vi.fn(
            async () => opts.createUserResult ?? { data: { user: { id: 'user-new' } }, error: null }
          ),
        },
      },
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => mockState.client,
}));

import { provisionTenant, SlugDerivationError } from './provision';

describe('provisionTenant — slug derivation', () => {
  beforeEach(() => {
    mockState = makeAdminClientMock();
  });

  it('uses the plain slug when it is free', async () => {
    mockState = makeAdminClientMock({ takenSlugs: new Set() });

    const result = await provisionTenant({
      firmName: 'Acme Prop',
      ownerEmail: 'owner@acme.com',
      ownerPassword: 'hunter22222',
    });

    expect(result.slug).toBe('acme-prop');
  });

  it('appends a numeric suffix when the base slug is taken', async () => {
    mockState = makeAdminClientMock({ takenSlugs: new Set(['acme-prop']) });

    const result = await provisionTenant({
      firmName: 'Acme Prop',
      ownerEmail: 'owner@acme.com',
      ownerPassword: 'hunter22222',
    });

    expect(result.slug).toBe('acme-prop-2');
  });

  it('walks past multiple collisions', async () => {
    mockState = makeAdminClientMock({
      takenSlugs: new Set(['acme-prop', 'acme-prop-2', 'acme-prop-3']),
    });

    const result = await provisionTenant({
      firmName: 'Acme Prop',
      ownerEmail: 'owner@acme.com',
      ownerPassword: 'hunter22222',
    });

    expect(result.slug).toBe('acme-prop-4');
  });
});

describe('provisionTenant — the tenant claim goes to app_metadata, never user_metadata', () => {
  beforeEach(() => {
    mockState = makeAdminClientMock();
  });

  it('creates the owner via the admin API with app_metadata {tenant_id, role: owner}', async () => {
    const result = await provisionTenant({
      firmName: 'Acme Prop',
      ownerEmail: 'owner@acme.com',
      ownerPassword: 'hunter22222',
    });

    const createUserMock = (mockState.client as { auth: { admin: { createUser: ReturnType<typeof vi.fn> } } })
      .auth.admin.createUser;
    const callArgs = createUserMock.mock.calls[0][0];

    expect(callArgs.email).toBe('owner@acme.com');
    expect(callArgs.password).toBe('hunter22222');
    expect(callArgs.app_metadata).toEqual({ tenant_id: result.tenantId, role: 'owner' });
    // RLS's auth_tenant_id()/auth_tenant_role() read app_metadata only — a
    // claim placed in user_metadata would compile fine and grant nothing.
    expect(callArgs.user_metadata).toBeUndefined();
  });

  it('records a tenant_members row with role owner', async () => {
    await provisionTenant({
      firmName: 'Acme Prop',
      ownerEmail: 'owner@acme.com',
      ownerPassword: 'hunter22222',
    });

    const memberInsert = mockState.calls.find(
      (c) => c.table === 'tenant_members' && c.op === 'insert'
    );
    expect(memberInsert).toBeDefined();
    expect((memberInsert!.payload as { role: string }).role).toBe('owner');
  });
});

describe('provisionTenant — cleans up a headless tenant on failure', () => {
  it('deletes the tenant row if creating the owner account fails', async () => {
    mockState = makeAdminClientMock({
      createUserResult: { data: null, error: new Error('email already registered') },
    });

    await expect(
      provisionTenant({
        firmName: 'Acme Prop',
        ownerEmail: 'owner@acme.com',
        ownerPassword: 'hunter22222',
      })
    ).rejects.toThrow();

    const deleteCall = mockState.calls.find((c) => c.table === 'tenants' && c.op === 'delete');
    expect(deleteCall).toBeDefined();
  });
});

describe('provisionTenant — bounded slug retries', () => {
  it('throws SlugDerivationError rather than looping forever', async () => {
    // Every candidate the derivation could try within its retry budget is
    // "taken", proving the loop is bounded rather than infinite.
    const taken = new Set(['acme-prop', ...Array.from({ length: 60 }, (_, i) => `acme-prop-${i + 2}`)]);
    mockState = makeAdminClientMock({ takenSlugs: taken });

    await expect(
      provisionTenant({
        firmName: 'Acme Prop',
        ownerEmail: 'owner@acme.com',
        ownerPassword: 'hunter22222',
      })
    ).rejects.toThrow(SlugDerivationError);
  });
});
