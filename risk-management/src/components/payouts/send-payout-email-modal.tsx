'use client';

import { useCallback, useMemo } from 'react';
import { SendViolationEmailBase } from '@/components/emails/send-violation-email-base';
import { VIOLATION_LABELS } from '@/lib/violations/labels';
import type { PayoutRecord } from '@/types/payouts';
import type { PayoutAnalysisResult } from './expanded-payout';

interface ViolationEntry {
  typeKey: string;
  label: string;
  deductionAmount: number;
}

interface Props {
  record: PayoutRecord;
  analysis: PayoutAnalysisResult;
  isOpen: boolean;
  onClose: () => void;
}

export function SendPayoutEmailModal({ record, analysis, isOpen, onClose }: Props) {
  const allViolations: ViolationEntry[] = useMemo(() => {
    const map = new Map<string, ViolationEntry>();
    if (!analysis.deduction_breakdown) return [];
    for (const [typeKey, amount] of Object.entries(analysis.deduction_breakdown)) {
      if (amount <= 0) continue;
      map.set(typeKey, {
        typeKey,
        label: VIOLATION_LABELS[typeKey] || typeKey,
        deductionAmount: amount,
      });
    }
    return Array.from(map.values());
  }, [analysis.deduction_breakdown]);

  const recipientEmail = record.email || '';
  const firstName = record.firstName || '';
  const login = record.login || record.accountId || '';
  const planName = record.plan || '';
  const payoutAmount = record.profitSharePercentage && record.profitSharePercentage > 0 && record.profitSharePercentage < 100 && (record.clientAmount ?? 0) > 0
    ? (record.clientAmount!) / (record.profitSharePercentage / 100)
    : record.amount ?? record.clientAmount ?? 0;
  const totalDeductions = allViolations.reduce((sum, v) => sum + v.deductionAmount, 0);

  const handleSend = useCallback(async (selectedViolations: ViolationEntry[]) => {
    const res = await fetch('/api/payouts/violation-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: record.accountId || record.login,
        login,
        email: recipientEmail,
        firstName,
        selectedViolations: selectedViolations.map((v) => ({
          label: v.label,
          deductionAmount: v.deductionAmount,
        })),
        planName,
        payoutAmount,
        totalDeductions,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (res.status === 409) {
      const error = new Error('Email already sent');
      (error as any).sentAt = data.sentAt;
      throw error;
    }

    if (!res.ok) throw new Error(data.error || 'Failed to send email');
  }, [record.accountId, record.login, login, recipientEmail, firstName, planName, payoutAmount, totalDeductions]);

  return (
    <SendViolationEmailBase
      accountId={record.accountId || record.login || ''}
      login={login}
      traderName={firstName}
      traderEmail={recipientEmail}
      violations={allViolations}
      payoutAmount={payoutAmount}
      totalDeductions={totalDeductions}
      isOpen={isOpen}
      onClose={onClose}
      onSend={handleSend}
      apiEndpoint="/api/payouts/violation-email"
      emailCheckEndpoint="/api/payouts/violation-email"
      modalTitle={`Send Violation Email — Login: ${login}`}
    />
  );
}
