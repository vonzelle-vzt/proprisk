import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockState: { client: unknown; calls: Array<Record<string, unknown>> };

interface InviteRow {
  id: string;
  tenant_id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
  invited_by: string;
}

function makeAdminClientMock(
  opts: {
    inviteRow?: InviteRow | null;
    createUserResult?: { data: { user: { id: string } } | null; error: Error | null };
  } = {}
) {
  const calls: Array<Record<string, unknown>> = [];

  function builder(table: string) {
    const b: Record<string, unknown> = {};
    const record = (op: string, payload?: unknown) => {
      calls.push({ table, op, payload });
      return b;
    };
    b.select = (cols?: unknown) => record('select', cols);
    b.insert = (rows: unknown) => record('insert', rows);
    b.update = (patch: unknown) => record('update', patch);
    b.eq = (col: string, val: unknown) => record('eq', { col, val });
    b.maybeSingle = () => {
      if (table === 'tenant_invites') {
        return Promise.resolve({ data: opts.inviteRow ?? null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    b.single = () => Promise.resolve({ data: { id: 'invite-id' }, error: null });
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

import { InvalidInviteError, createInvite, redeemInvite } from './invites';

describe('createInvite — the raw token is never persisted', () => {
  beforeEach(() => {
    mockState = makeAdminClientMock();
  });

  it('stores only a sha256 hash of the token, and returns the raw token separately', async () => {
    const result = await createInvite({
      tenantId: 'tenant-A',
      email: 'new@firm.com',
      role: 'admin',
      invitedBy: 'owner-a',
    });

    const insertCall = mockState.calls.find((c) => c.table === 'tenant_invites' && c.op === 'insert');
    expect(insertCall).toBeDefined();
    const payload = insertCall!.payload as { token_hash: string; tenant_id: string };

    expect(payload.tenant_id).toBe('tenant-A');
    expect(payload.token_hash).toBe(createHash('sha256').update(result.token).digest('hex'));
    expect(payload.token_hash).not.toBe(result.token);
    // Not a fixed test double: verify it's a real 32-byte token round-tripped
    // through sha256 (64 hex chars), not a placeholder.
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
  });
});

function futureIso(hours = 1): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function pastIso(hours = 1): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

describe('redeemInvite — CRITICAL: an invite is bound to the tenant it was issued for', () => {
  it('resolves strictly from the token — tenant A\'s invite redeems into tenant A', async () => {
    mockState = makeAdminClientMock({
      inviteRow: {
        id: 'invite-a',
        tenant_id: 'tenant-A',
        email: 'analyst@a.com',
        role: 'admin',
        expires_at: futureIso(),
        accepted_at: null,
        invited_by: 'owner-a',
      },
    });

    const result = await redeemInvite({ token: 'irrelevant-plaintext-a', password: 'password123' });

    expect(result.tenantId).toBe('tenant-A');
    expect(result.role).toBe('admin');

    const createUserMock = (mockState.client as { auth: { admin: { createUser: ReturnType<typeof vi.fn> } } })
      .auth.admin.createUser;
    const args = createUserMock.mock.calls[0][0];
    // The claim minted for the new user comes from the invite row the TOKEN
    // resolved to — never from anything the redeemer supplied. There is no
    // tenant field on RedeemInviteInput at all, so a caller has no way to
    // even ask for tenant B.
    expect(args.app_metadata).toEqual({ tenant_id: 'tenant-A', role: 'admin' });
  });

  it('resolves a different token to its own (different) tenant — B stays B', async () => {
    mockState = makeAdminClientMock({
      inviteRow: {
        id: 'invite-b',
        tenant_id: 'tenant-B',
        email: 'analyst@b.com',
        role: 'viewer',
        expires_at: futureIso(),
        accepted_at: null,
        invited_by: 'owner-b',
      },
    });

    const result = await redeemInvite({ token: 'irrelevant-plaintext-b', password: 'password123' });

    expect(result.tenantId).toBe('tenant-B');
    expect(result.tenantId).not.toBe('tenant-A');
  });

  it('records the new membership under the invite\'s own tenant, not a caller-chosen one', async () => {
    mockState = makeAdminClientMock({
      inviteRow: {
        id: 'invite-a',
        tenant_id: 'tenant-A',
        email: 'analyst@a.com',
        role: 'risk_manager',
        expires_at: futureIso(),
        accepted_at: null,
        invited_by: 'owner-a',
      },
    });

    await redeemInvite({ token: 'irrelevant-plaintext-a', password: 'password123' });

    const memberInsert = mockState.calls.find((c) => c.table === 'tenant_members' && c.op === 'insert');
    expect(memberInsert).toBeDefined();
    expect((memberInsert!.payload as { tenant_id: string; role: string })).toEqual({
      tenant_id: 'tenant-A',
      role: 'risk_manager',
      invited_by: 'owner-a',
      user_id: 'user-new',
    });
  });
});

describe('redeemInvite — expiry and single-use', () => {
  it('refuses a token that does not match any invite', async () => {
    mockState = makeAdminClientMock({ inviteRow: null });

    await expect(redeemInvite({ token: 'no-such-token', password: 'password123' })).rejects.toThrow(
      InvalidInviteError
    );
  });

  it('refuses an expired invite', async () => {
    mockState = makeAdminClientMock({
      inviteRow: {
        id: 'invite-a',
        tenant_id: 'tenant-A',
        email: 'analyst@a.com',
        role: 'admin',
        expires_at: pastIso(),
        accepted_at: null,
        invited_by: 'owner-a',
      },
    });

    await expect(redeemInvite({ token: 'x', password: 'password123' })).rejects.toThrow(InvalidInviteError);
  });

  it('refuses an already-accepted invite', async () => {
    mockState = makeAdminClientMock({
      inviteRow: {
        id: 'invite-a',
        tenant_id: 'tenant-A',
        email: 'analyst@a.com',
        role: 'admin',
        expires_at: futureIso(),
        accepted_at: pastIso(1),
        invited_by: 'owner-a',
      },
    });

    await expect(redeemInvite({ token: 'x', password: 'password123' })).rejects.toThrow(InvalidInviteError);
  });
});
