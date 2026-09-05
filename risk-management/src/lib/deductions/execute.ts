import { createAdminClient } from '@/lib/supabase/admin';
import { ViolationType } from '@/types/database';
import { sendViolationEmail } from '@/lib/emails/send';
import { logAuditEvent } from '@/lib/deductions/audit';
import { logError } from '@/lib/logging/logger';

interface DeductionParams {
  account_id: string;
  violation_id?: string;
  amount: number;
  reason: string;
  execution_type: 'automatic' | 'manual';
  executed_by?: string;
  violation_type?: ViolationType;
}

interface DeductionResult {
  success: boolean;
  deduction_id?: string;
  error?: string;
}

export async function executeDeduction(params: DeductionParams): Promise<DeductionResult> {
  const supabase = createAdminClient();

  try {
    // Get current account balance
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', params.account_id)
      .single();

    if (accountError || !account) {
      return { success: false, error: `Account not found: ${params.account_id}` };
    }

    const preBalance = account.balance;
    const postBalance = preBalance - params.amount;

    // Preferred path: insert the deduction row and debit the balance atomically
    // via the DB function, so a balance-update failure can never leave an
    // orphaned deduction row that a retry would double-count.
    const rpc = await supabase.rpc('execute_deduction_atomic', {
      p_account_id: params.account_id,
      p_violation_id: params.violation_id || null,
      p_amount: params.amount,
      p_pre_balance: preBalance,
      p_post_balance: postBalance,
      p_executed_by: params.executed_by || 'system',
      p_execution_type: params.execution_type,
      p_reason: params.reason,
    });

    let deduction: { id: string } | null = null;

    if (!rpc.error) {
      deduction = rpc.data as { id: string } | null;
      if (!deduction) {
        return { success: false, error: 'Failed to create deduction record: empty result' };
      }
    } else if (rpc.error.code === 'PGRST202') {
      // Legacy DB predating migration 00014 — two-step fallback with best-
      // effort compensation on balance-update failure.
      const { data: inserted, error: deductionError } = await supabase
        .from('deductions')
        .insert({
          violation_id: params.violation_id || null,
          account_id: params.account_id,
          amount: params.amount,
          pre_balance: preBalance,
          post_balance: postBalance,
          executed_by: params.executed_by || 'system',
          execution_type: params.execution_type,
          reason: params.reason,
        })
        .select()
        .single();

      if (deductionError || !inserted) {
        return { success: false, error: `Failed to create deduction record: ${deductionError?.message}` };
      }
      deduction = inserted;

      const { error: updateError } = await supabase
        .from('accounts')
        .update({ balance: postBalance })
        .eq('id', params.account_id);

      if (updateError) {
        // Compensate: delete the just-inserted row so a retry can't double-
        // deduct. Best-effort — log if the cleanup itself fails.
        const { error: deleteError } = await supabase
          .from('deductions')
          .delete()
          .eq('id', inserted.id);
        if (deleteError) {
          logError('Failed to compensate orphaned deduction after balance-update failure', deleteError, {
            route: 'lib/deductions/execute',
            category: 'database',
            account_id: params.account_id,
          });
        }
        return { success: false, error: `Failed to update balance: ${updateError.message}` };
      }
    } else {
      return { success: false, error: `Failed to create deduction record: ${rpc.error.message}` };
    }

    // Every non-returning branch above sets `deduction`; this narrows the type
    // and guards against an unexpected empty result.
    if (!deduction) {
      return { success: false, error: 'Failed to create deduction record' };
    }

    // Update violation status if linked
    if (params.violation_id) {
      await supabase
        .from('violations')
        .update({ status: 'deducted' })
        .eq('id', params.violation_id);
    }

    // Log audit event
    await logAuditEvent({
      action_type: 'deduction_executed',
      entity_type: 'deduction',
      entity_id: deduction.id,
      performed_by: params.executed_by || 'system',
      details: {
        account_id: params.account_id,
        account_login: account.login,
        amount: params.amount,
        pre_balance: preBalance,
        post_balance: postBalance,
        violation_id: params.violation_id,
        execution_type: params.execution_type,
        reason: params.reason,
      },
    });

    // Send notification email
    if (params.violation_type) {
      await sendViolationEmail({
        account,
        violation_type: params.violation_type,
        deduction_amount: params.amount,
        deduction_id: deduction.id,
        violation_id: params.violation_id,
      }).catch((err) => {
        console.error('Failed to send violation email:', err);
      });
    }

    return { success: true, deduction_id: deduction.id };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
