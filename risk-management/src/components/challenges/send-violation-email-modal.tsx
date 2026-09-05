'use client';

import { useCallback, useMemo } from 'react';
import { SendViolationEmailBase } from '@/components/emails/send-violation-email-base';
import { VIOLATION_LABELS } from '@/lib/violations/labels';
import type { PassedChallengeAccount, AnalysisResult } from '@/hooks/use-challenge-dashboard';

interface ViolationEntry {
  typeKey: string;
  label: string;
  deductionAmount: number;
}

interface Props {
  account: PassedChallengeAccount;
  result: AnalysisResult;
  isOpen: boolean;
  onClose: () => void;
}

export function SendViolationEmailModal({ account, result, isOpen, onClose }: Props) {
  // Collect all violations from phase1 + phase2, de-duped by typeKey
  const allViolations: ViolationEntry[] = useMemo(() => {
    const map = new Map<string, ViolationEntry>();
    for (const phase of [result.phase2, result.phase1]) {
      if (!phase?.deduction_breakdown) continue;
      for (const [typeKey, amount] of Object.entries(phase.deduction_breakdown)) {
        if (amount <= 0) continue;
        if (!map.has(typeKey)) {
          map.set(typeKey, {
            typeKey,
            label: VIOLATION_LABELS[typeKey] || typeKey,
            deductionAmount: amount,
          });
        } else {
          map.get(typeKey)!.deductionAmount += amount;
        }
      }
    }
    return Array.from(map.values());
  }, [result.phase1, result.phase2]);

  const primaryPhase = result.phase2 || result.phase1;
  const phaseLabel = primaryPhase?.phase_label || 'Phase';
  const planName = primaryPhase?.plan || account.planName || '';
  const recipientEmail = account.email || primaryPhase?.email || '';
  const firstName = account.firstName || primaryPhase?.first_name || '';

  // Violated accounts for display and email
  const violatedAccounts = useMemo(() => {
    const accounts = [
      result.phase1 && (result.phase1.total_deductions ?? 0) > 0
        ? { login: String(result.phase1.login), phaseLabel: result.phase1.phase_label }
        : null,
      result.phase2 && (result.phase2.total_deductions ?? 0) > 0
        ? { login: String(result.phase2.login), phaseLabel: result.phase2.phase_label }
        : null,
    ].filter(Boolean) as { login: string; phaseLabel: string }[];
    return accounts.length > 0 ? accounts : [{ login: String(account.login), phaseLabel: '' }];
  }, [result.phase1, result.phase2, account.login]);

  const violatedLoginLabel = useMemo(
    () => violatedAccounts
      .map((a) => `${a.login}${a.phaseLabel ? ` (${a.phaseLabel})` : ''}`)
      .join(', '),
    [violatedAccounts]
  );

  const modalTitle = `Send Violation Email — ${violatedAccounts.length > 1 ? 'Logins' : 'Login'}: ${violatedLoginLabel}`;

  const handleSend = useCallback(async (selectedViolations: ViolationEntry[], retryAccountId?: string) => {
    const res = await fetch('/api/challenges/violation-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: account.accountId,
        violatedAccounts,
        email: recipientEmail,
        firstName,
        retryAccountId: retryAccountId?.trim() || '',
        selectedViolations: selectedViolations.map((v) => ({
          label: v.label,
          deductionAmount: v.deductionAmount,
        })),
        planName,
        phaseLabel,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (res.status === 409) {
      const error = new Error('Email already sent');
      (error as any).sentAt = data.sentAt;
      throw error;
    }

    if (!res.ok) {
      throw new Error(data.error || 'Failed to send email');
    }
  }, [account.accountId, violatedAccounts, recipientEmail, firstName, planName, phaseLabel]);

  return (
    <SendViolationEmailBase
      accountId={String(account.accountId)}
      login={String(account.login)}
      traderName={firstName}
      traderEmail={recipientEmail}
      violations={allViolations}
      phaseLabel={phaseLabel}
      retryAccountId=""
      isOpen={isOpen}
      onClose={onClose}
      onSend={handleSend}
      apiEndpoint="/api/challenges/violation-email"
      emailCheckEndpoint="/api/challenges/violation-email"
      modalTitle={modalTitle}
    />
  );
}
