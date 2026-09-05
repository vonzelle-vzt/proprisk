import { beforeEach, describe, expect, it, vi } from 'vitest';

const createAdminClientMock = vi.fn();
const logAuditEventMock = vi.fn();
const sendViolationEmailMock = vi.fn();

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => createAdminClientMock(),
}));

vi.mock('@/lib/deductions/audit', () => ({
  logAuditEvent: (...args: unknown[]) => logAuditEventMock(...args),
}));

vi.mock('@/lib/emails/send', () => ({
  sendViolationEmail: (...args: unknown[]) => sendViolationEmailMock(...args),
}));

import { executeDeduction } from './execute';

interface MockOptions {
  account?: Record<string, unknown> | null;
  accountError?: { message: string } | null;
  deduction?: Record<string, unknown> | null;
  deductionError?: { message: string } | null;
  updateBalanceError?: { message: string } | null;
  deleteDeductionError?: { message: string } | null;
  // rpc defaults to "function not found" so the existing tests exercise the
  // two-step fallback path. Pass rpcData / non-PGRST202 rpcError to exercise
  // the atomic RPC path instead.
  rpcData?: Record<string, unknown> | null;
  rpcError?: { code: string; message: string } | null;
}

const updateAccountEqMock = vi.fn();
const updateViolationEqMock = vi.fn();
const deleteDeductionEqMock = vi.fn();
const rpcMock = vi.fn();

function buildSupabaseMock(opts: MockOptions) {
  const account = opts.account ?? {
    id: 'account-1',
    login: '1001',
    email: 'trader@example.com',
    trader_name: 'Jane Doe',
    balance: 10000,
  };
  const deduction = opts.deduction ?? {
    id: 'deduction-1',
    account_id: 'account-1',
    amount: 300,
    pre_balance: 10000,
    post_balance: 9700,
  };
  const rpcError =
    opts.rpcError === undefined
      ? { code: 'PGRST202', message: 'Could not find the function' }
      : opts.rpcError;

  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcMock(name, args);
      if (rpcError) return { data: null, error: rpcError };
      return { data: opts.rpcData ?? deduction, error: null };
    },
    from: (table: string) => {
      if (table === 'accounts') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: opts.accountError ? null : account, error: opts.accountError ?? null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: async (...args: unknown[]) => {
              updateAccountEqMock(payload, ...args);
              return { error: opts.updateBalanceError ?? null };
            },
          }),
        };
      }
      if (table === 'deductions') {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({ data: opts.deductionError ? null : deduction, error: opts.deductionError ?? null }),
            }),
          }),
          delete: () => ({
            eq: async (...args: unknown[]) => {
              deleteDeductionEqMock(...args);
              return { error: opts.deleteDeductionError ?? null };
            },
          }),
        };
      }
      if (table === 'violations') {
        return {
          update: (payload: Record<string, unknown>) => ({
            eq: async (...args: unknown[]) => {
              updateViolationEqMock(payload, ...args);
              return { error: null };
            },
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
}

describe('executeDeduction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logAuditEventMock.mockResolvedValue('hash123');
    sendViolationEmailMock.mockResolvedValue(undefined);
  });

  it('computes pre/post balance correctly and creates a deduction record', async () => {
    createAdminClientMock.mockReturnValue(buildSupabaseMock({}));

    const result = await executeDeduction({
      account_id: 'account-1',
      amount: 300,
      reason: 'HFT violation',
      execution_type: 'automatic',
    });

    expect(result.success).toBe(true);
    expect(result.deduction_id).toBe('deduction-1');
    // Balance update called with post_balance = 10000 - 300 = 9700
    expect(updateAccountEqMock).toHaveBeenCalledWith({ balance: 9700 }, 'id', 'account-1');
  });

  it('updates violation status to deducted when violation_id is provided', async () => {
    createAdminClientMock.mockReturnValue(buildSupabaseMock({}));

    await executeDeduction({
      account_id: 'account-1',
      violation_id: 'violation-1',
      amount: 300,
      reason: 'HFT violation',
      execution_type: 'automatic',
    });

    expect(updateViolationEqMock).toHaveBeenCalledWith({ status: 'deducted' }, 'id', 'violation-1');
  });

  it('does not touch violations table when violation_id is absent', async () => {
    createAdminClientMock.mockReturnValue(buildSupabaseMock({}));

    await executeDeduction({
      account_id: 'account-1',
      amount: 300,
      reason: 'HFT violation',
      execution_type: 'automatic',
    });

    expect(updateViolationEqMock).not.toHaveBeenCalled();
  });

  it('logs an audit event with pre/post balance details', async () => {
    createAdminClientMock.mockReturnValue(buildSupabaseMock({}));

    await executeDeduction({
      account_id: 'account-1',
      amount: 300,
      reason: 'HFT violation',
      execution_type: 'manual',
      executed_by: 'reviewer@example.com',
    });

    expect(logAuditEventMock).toHaveBeenCalledTimes(1);
    const [params] = logAuditEventMock.mock.calls[0];
    expect(params.action_type).toBe('deduction_executed');
    expect(params.details.pre_balance).toBe(10000);
    expect(params.details.post_balance).toBe(9700);
    expect(params.details.execution_type).toBe('manual');
  });

  it('sends a violation email when violation_type is provided, and does not fail the deduction if the email rejects', async () => {
    createAdminClientMock.mockReturnValue(buildSupabaseMock({}));
    sendViolationEmailMock.mockRejectedValue(new Error('smtp down'));

    const result = await executeDeduction({
      account_id: 'account-1',
      amount: 300,
      reason: 'HFT violation',
      execution_type: 'automatic',
      violation_type: 'hft',
    });

    expect(result.success).toBe(true);
    expect(sendViolationEmailMock).toHaveBeenCalledTimes(1);
  });

  it('does not send an email when violation_type is absent', async () => {
    createAdminClientMock.mockReturnValue(buildSupabaseMock({}));

    await executeDeduction({
      account_id: 'account-1',
      amount: 300,
      reason: 'HFT violation',
      execution_type: 'automatic',
    });

    expect(sendViolationEmailMock).not.toHaveBeenCalled();
  });

  it('returns a failure result when the account is not found, without creating a deduction', async () => {
    createAdminClientMock.mockReturnValue(
      buildSupabaseMock({ accountError: { message: 'not found' } })
    );

    const result = await executeDeduction({
      account_id: 'missing-account',
      amount: 300,
      reason: 'HFT violation',
      execution_type: 'automatic',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Account not found');
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  it('returns a failure result when the deduction insert fails', async () => {
    createAdminClientMock.mockReturnValue(
      buildSupabaseMock({ deductionError: { message: 'insert failed' } })
    );

    const result = await executeDeduction({
      account_id: 'account-1',
      amount: 300,
      reason: 'HFT violation',
      execution_type: 'automatic',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to create deduction record');
    expect(updateAccountEqMock).not.toHaveBeenCalled();
  });

  it('returns a failure result when the balance update fails', async () => {
    createAdminClientMock.mockReturnValue(
      buildSupabaseMock({ updateBalanceError: { message: 'update failed' } })
    );

    const result = await executeDeduction({
      account_id: 'account-1',
      amount: 300,
      reason: 'HFT violation',
      execution_type: 'automatic',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to update balance');
    // The audit log should not have been reached in this failure path.
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  it('uses the atomic RPC when available and does not fall back to the two-step path', async () => {
    createAdminClientMock.mockReturnValue(buildSupabaseMock({ rpcError: null }));

    const result = await executeDeduction({
      account_id: 'account-1',
      amount: 300,
      reason: 'HFT violation',
      execution_type: 'automatic',
    });

    expect(result.success).toBe(true);
    expect(result.deduction_id).toBe('deduction-1');
    // Balance debit happened inside the RPC, not via a separate accounts update.
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [name, args] = rpcMock.mock.calls[0];
    expect(name).toBe('execute_deduction_atomic');
    expect(args.p_post_balance).toBe(9700);
    expect(updateAccountEqMock).not.toHaveBeenCalled();
    expect(deleteDeductionEqMock).not.toHaveBeenCalled();
  });

  it('compensates (deletes the orphaned row) when the fallback balance update fails', async () => {
    createAdminClientMock.mockReturnValue(
      buildSupabaseMock({ updateBalanceError: { message: 'update failed' } })
    );

    const result = await executeDeduction({
      account_id: 'account-1',
      amount: 300,
      reason: 'HFT violation',
      execution_type: 'automatic',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to update balance');
    // The just-inserted deduction row must be deleted so a retry can't double-deduct.
    expect(deleteDeductionEqMock).toHaveBeenCalledWith('id', 'deduction-1');
    // Audit log must not be reached on this failure path.
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  it('catches unexpected errors and returns them as a failure result', async () => {
    createAdminClientMock.mockReturnValue({
      from: () => {
        throw new Error('unexpected boom');
      },
    });

    const result = await executeDeduction({
      account_id: 'account-1',
      amount: 300,
      reason: 'HFT violation',
      execution_type: 'automatic',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('unexpected boom');
  });
});
