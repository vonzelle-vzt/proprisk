export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { preApprovePayout, approvePayout, rejectPayout } from '@/lib/platform/client';
import { savePayoutSnapshot } from '@/lib/payouts/snapshot';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { DEMO_MODE } from '@/lib/demo';
import { composeDecisionRationale, polishExplanation } from '@/lib/payouts/decision';
import { logAuditEvent } from '@/lib/audit/chain';
import { tenantDb } from '@/lib/db/tenant-scoped';
import { logError } from '@/lib/logging/logger';
import type { PayoutRecord } from '@/types/payouts';
import { invalidate } from '@/lib/cache/provider-cache';
import { requireRiskManager } from '@/lib/auth/guards';

/**
 * POST /api/payouts/[id]/preapprove
 * Body: { action: 'preapprove' | 'approve' | 'reject', status?: number, note?: string, record?: PayoutRecord }
 *
 * action=preapprove: set pre-approval status (-1, 0, 1) on the provider platform
 * action=approve: finalize payout approval on the provider platform (paid) — saves snapshot first
 * action=reject: finalize payout rejection on the provider platform (not paid) — saves snapshot first
 *
 * approve/reject also compose an explainable decision (rationale + human
 * explanation), persist it to `payout_decisions`, and log it through the
 * hash-chained audit trail. That persistence is best-effort: a failure there
 * must not fail the provider action that already succeeded — it's surfaced
 * as a `warning` on the response instead.
 *
 * Every action here moves money, so it requires risk_manager|admin — and the
 * approving human is recorded by identity. An audit trail that cannot name the
 * approver is not evidence, which is the whole point of this record.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (DEMO_MODE) {
    const body = await request.json().catch(() => ({ action: 'preapprove' }));
    const { action, record } = body || {};
    const result: Record<string, unknown> = {
      ok: true,
      demo: true,
      id,
      action: action || 'preapprove',
      message: 'Demo mode — no live platform call made.',
    };
    if ((action === 'approve' || action === 'reject') && record) {
      const composed = composeDecisionRationale({ record: record as PayoutRecord, decision: action });
      result.rationale = composed.rationale;
      result.explanation = composed.explanation;
    }
    return Response.json(result);
  }

  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;
  const actor = auth.actor;

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const rl = await checkRateLimit(`preapprove:${ip}`, { windowMs: 60_000, maxRequests: 10 });
  if (!rl.allowed) return rateLimitResponse(rl);

  const body = await request.json();
  const { action, status, note, record } = body;

  try {
    if (action === 'preapprove') {
      if (typeof status !== 'number' || ![-1, 0, 1].includes(status)) {
        return Response.json({ error: 'Invalid status. Must be -1, 0, or 1.' }, { status: 400 });
      }
      await preApprovePayout(id, status, note || '', auth.tenantId);

      // Best-effort: never fail an already-succeeded provider call over a
      // cache invalidation error.
      try {
        await invalidate('provider:payouts');
      } catch (err) {
        console.error('[preapprove] cache invalidation failed', err);
      }

      const labels: Record<number, string> = { '-1': 'Not Pre-Approved', '0': 'Not Reviewed', '1': 'Pre-Approved' };
      return Response.json({ success: true, preApprovalStatus: status, label: labels[status] });
    }

    if (action === 'approve' || action === 'reject') {
      const dbDecision = action === 'approve' ? 'approved' : 'rejected';

      // A final decision must carry the enriched record it's finalizing —
      // otherwise we'd act on the provider with zero snapshot/decision/audit
      // trail. Reject rather than finalize silently.
      if (!record) {
        return Response.json({ error: 'record required for final decisions' }, { status: 400 });
      }

      // Finalize on the provider FIRST. Only after the provider call actually
      // succeeds do we persist the snapshot/decision/audit rows — so a provider
      // failure can never leave a phantom "approved/paid" history row behind.
      try {
        if (action === 'approve') {
          await approvePayout(id, actor, note || '', auth.tenantId);
        } else {
          await rejectPayout(id, note || 'Rejected via Risk Management', actor, auth.tenantId);
        }
      } catch (providerErr) {
        logError('Provider payout finalization failed', providerErr, {
          route: 'api/payouts/[id]/preapprove',
          category: 'external_api',
          payout_id: id,
        });
        // Provider call failed — no snapshot, no decision row was written.
        return Response.json({ error: 'Trading platform call failed' }, { status: 502 });
      }

      // Provider action succeeded — now durably record it. savePayoutSnapshot
      // is internally best-effort (logs + returns null on DB error), so a
      // snapshot failure won't fail the already-succeeded provider action.
      await savePayoutSnapshot(record, dbDecision, actor, note || undefined);

      // Best-effort: never fail an already-succeeded provider call over a
      // cache invalidation error. This writes payout_decisions below too, so
      // the payouts prefix (and its enriched pending list) must drop.
      try {
        await invalidate('provider:payouts');
      } catch (err) {
        console.error('[preapprove] cache invalidation failed', err);
      }

      // Explainable payout decision — best-effort, never fails the response
      // above (the provider action already succeeded by this point).
      let decisionPayload: { rationale: ReturnType<typeof composeDecisionRationale>['rationale']; explanation: string } | null = null;
      let warning: string | undefined;

      try {
        const composed = composeDecisionRationale({ record: record as PayoutRecord, decision: action });
        const explanation = await polishExplanation(composed);
        decisionPayload = { rationale: composed.rationale, explanation };

        const auditHash = await logAuditEvent({
          action_type: 'payout_decision',
          entity_type: 'payout',
          entity_id: id,
          performed_by: actor,
          details: {
            decision: action,
            // Immutable id alongside the human-readable label: emails can be
            // reassigned, a user id cannot.
            actor_user_id: auth.user.id,
            actor_role: auth.role,
            accountId: record.accountId,
            rationale: composed.rationale,
            explanation,
            note: note || undefined,
          },
        });

        const db = tenantDb(auth.tenantId);
        const { error: insertError } = await db.insert('payout_decisions', {
          payout_id: id,
          account_id: record.accountId || null,
          decision: action,
          actor,
          rationale: composed.rationale,
          explanation,
          audit_hash: auditHash,
        });

        if (insertError) {
          logError('Failed to persist payout decision', insertError, {
            route: 'api/payouts/[id]/preapprove',
            category: 'database',
          });
          warning = 'Provider action succeeded, but the explainable-decision record failed to save.';
        }
      } catch (decisionErr) {
        logError('Payout decision composition/persistence failed', decisionErr, {
          route: 'api/payouts/[id]/preapprove',
          category: 'database',
        });
        warning = 'Provider action succeeded, but the explainable-decision record failed to save.';
      }

      return Response.json({
        success: true,
        action: dbDecision,
        ...(decisionPayload ? { rationale: decisionPayload.rationale, explanation: decisionPayload.explanation } : {}),
        ...(warning ? { warning } : {}),
      });
    }

    return Response.json({ error: 'Invalid action. Must be preapprove, approve, or reject.' }, { status: 400 });
  } catch {
    return Response.json({ error: 'Trading platform call failed' }, { status: 500 });
  }
}
