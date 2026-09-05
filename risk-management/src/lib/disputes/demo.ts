import { FOREX_ACCOUNTS } from '@/lib/mock/dataset.forex';
import { FUTURES_ACCOUNTS } from '@/lib/mock/dataset.futures';
import { encodeDemoEvidenceId } from '@/lib/evidence/builder';
import type { Dispute, DisputeStatus, DisputeSubjectType, RuleOverturnRate } from './types';
import { violationLabel } from '@/lib/violations/labels';

/**
 * DEMO_MODE fixtures — coherent, stateless mock data for the sales demo, the
 * same chokepoint pattern as `src/lib/mock/builders.ts` (never touches
 * Supabase). Kept local to `lib/disputes/` (out of this feature's
 * FILES_IN_SCOPE would be `lib/mock/**`) rather than added to the shared
 * builders module.
 *
 * Mutations (open/transition) are request-scoped, like the enforcement
 * queue's DEMO_MODE PATCH branch: they return a plausible resulting record
 * without a backing store, since demo mode has no writable database.
 */

function accountWithDeductions(index: number) {
  const withDeductions = [...FOREX_ACCOUNTS, ...FUTURES_ACCOUNTS].filter(
    (a) => Object.keys(a.deductionBreakdown).length > 0
  );
  return withDeductions[index % withDeductions.length] ?? FOREX_ACCOUNTS[0];
}

function fixture(
  index: number,
  overrides: Partial<Dispute> & { subjectType: DisputeSubjectType; status: DisputeStatus }
): Dispute {
  const account = accountWithDeductions(index);
  const vtype = Object.keys(account.deductionBreakdown)[0] ?? 'hft';
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  return {
    id: `demo-dispute-${index}`,
    tenantId: 'demo-tenant',
    subjectType: overrides.subjectType,
    subjectId: overrides.subjectType === 'payout' ? `payout-${account.accountId}` : account.accountId,
    accountId: account.accountId,
    raisedBy: `${account.firstName} ${account.lastName}`,
    raisedAt: daysAgo(6 - index),
    traderStatement:
      overrides.traderStatement ??
      `I don't believe the ${violationLabel(vtype)} flag on account ${account.accountId} is accurate — please review the trade tape.`,
    status: overrides.status,
    resolution: overrides.resolution ?? null,
    resolvedBy: overrides.resolvedBy ?? null,
    resolvedAt: overrides.resolvedAt ?? null,
    evidencePackId: encodeDemoEvidenceId('violation', account.accountId),
    auditHash: `demo-hash-${index}`,
    createdAt: daysAgo(6 - index),
    updatedAt: overrides.resolvedAt ?? daysAgo(6 - index),
  };
}

const DEMO_DISPUTES: Dispute[] = [
  fixture(0, { subjectType: 'breach', status: 'open' }),
  fixture(1, { subjectType: 'deduction', status: 'under_review' }),
  fixture(2, {
    subjectType: 'breach',
    status: 'overturned',
    resolution:
      'On review, the flagged trades fell inside an approved news-blackout exemption for this account’s plan tier. Deduction reversed and balance restored.',
    resolvedBy: 'Dana Reyes (Risk Manager)',
    resolvedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  }),
  fixture(3, {
    subjectType: 'deduction',
    status: 'upheld',
    resolution: 'Trade tape confirms the martingale escalation pattern as flagged. Deduction stands.',
    resolvedBy: 'Dana Reyes (Risk Manager)',
    resolvedAt: new Date(Date.now() - 1 * 86_400_000).toISOString(),
  }),
  fixture(4, {
    subjectType: 'payout',
    status: 'withdrawn',
    resolution: 'Trader withdrew the dispute after reviewing the deduction math directly with support.',
    resolvedBy: 'Dana Reyes (Risk Manager)',
    resolvedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  }),
  fixture(5, { subjectType: 'breach', status: 'overturned', resolvedBy: 'Dana Reyes (Risk Manager)', resolvedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(), resolution: 'Rule pack version mismatch at detection time — the account was on an older, corrected threshold. Overturned.' }),
];

export function demoListDisputes(filters: { status?: DisputeStatus; subjectType?: DisputeSubjectType } = {}): Dispute[] {
  return DEMO_DISPUTES.filter(
    (d) => (!filters.status || d.status === filters.status) && (!filters.subjectType || d.subjectType === filters.subjectType)
  );
}

export function demoGetDispute(id: string): Dispute | null {
  return DEMO_DISPUTES.find((d) => d.id === id) ?? null;
}

export function demoOpenDispute(input: {
  subjectType: DisputeSubjectType;
  subjectId: string;
  accountId?: string | null;
  raisedBy: string;
  traderStatement: string;
}): Dispute {
  const now = new Date().toISOString();
  return {
    id: `demo-dispute-${Date.now()}`,
    tenantId: 'demo-tenant',
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    accountId: input.accountId ?? null,
    raisedBy: input.raisedBy,
    raisedAt: now,
    traderStatement: input.traderStatement,
    status: 'open',
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    evidencePackId: input.accountId ? encodeDemoEvidenceId('violation', input.accountId) : null,
    auditHash: `demo-hash-${Date.now()}`,
    createdAt: now,
    updatedAt: now,
  };
}

export function demoTransitionDispute(
  id: string,
  status: DisputeStatus,
  resolution: string | undefined,
  actor: string
): Dispute {
  const existing = demoGetDispute(id) ?? {
    id,
    tenantId: 'demo-tenant',
    subjectType: 'breach' as DisputeSubjectType,
    subjectId: 'demo',
    accountId: null,
    raisedBy: 'Demo Trader',
    raisedAt: new Date().toISOString(),
    traderStatement: 'Demo dispute.',
    status: 'open' as DisputeStatus,
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    evidencePackId: null,
    auditHash: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const now = new Date().toISOString();
  const isTerminal = status !== 'under_review';
  return {
    ...existing,
    status,
    resolution: isTerminal ? resolution ?? existing.resolution : existing.resolution,
    resolvedBy: isTerminal ? actor : existing.resolvedBy,
    resolvedAt: isTerminal ? now : existing.resolvedAt,
    updatedAt: now,
  };
}

export function demoOverturnRateByRule(): RuleOverturnRate[] {
  const resolved = DEMO_DISPUTES.filter((d) => d.status === 'upheld' || d.status === 'overturned');
  const counts = new Map<string, { total: number; overturned: number; label: string }>();

  for (const d of resolved) {
    const account = [...FOREX_ACCOUNTS, ...FUTURES_ACCOUNTS].find((a) => a.accountId === d.accountId);
    const ruleId = d.subjectType === 'payout' ? 'payout_decision' : Object.keys(account?.deductionBreakdown ?? {})[0] ?? 'unknown';
    const entry = counts.get(ruleId) ?? { total: 0, overturned: 0, label: ruleId === 'payout_decision' ? 'Payout Decisions' : violationLabel(ruleId) };
    entry.total += 1;
    if (d.status === 'overturned') entry.overturned += 1;
    counts.set(ruleId, entry);
  }

  return Array.from(counts.entries())
    .map(([ruleId, { total, overturned, label }]) => ({
      ruleId,
      ruleLabel: label,
      totalResolved: total,
      overturned,
      overturnRate: total > 0 ? overturned / total : 0,
    }))
    .sort((a, b) => b.overturnRate - a.overturnRate || b.totalResolved - a.totalResolved);
}
