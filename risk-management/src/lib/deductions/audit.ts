/**
 * Re-export shim. The tamper-evident audit chain logger moved to
 * `src/lib/audit/chain.ts` (generalized so non-deduction subsystems, like
 * explainable payout decisions, can log through the same chain). Kept here
 * so existing `@/lib/deductions/audit` imports keep working unchanged.
 */
export { logAuditEvent } from '@/lib/audit/chain';
export type { AuditActionType } from '@/lib/audit/chain';
