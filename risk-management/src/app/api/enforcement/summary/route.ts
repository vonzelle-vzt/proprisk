export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';
import type { EnforcementRecommendation, EscalationLevel, EnforcementActionType } from '@/types/enforcement';
import { DEMO_MODE, assetClassFromRequest } from '@/lib/demo';
import { buildEnforcementSummary } from '@/lib/mock/builders';

export async function GET(request: NextRequest) {
  if (DEMO_MODE) return NextResponse.json(buildEnforcementSummary(assetClassFromRequest(request)));
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('enforcement-summary', { windowMs: 60_000, maxRequests: 30 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const supabase = await createClient();

    // Fetch pending items for summary stats
    const { data: pendingItems, error: pendingError } = await supabase
      .from('enforcement_queue')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (pendingError) {
      logError('Failed to fetch pending enforcement items', pendingError, {
        route: '/api/enforcement/summary',
        category: 'database',
      });
    }

    // Fetch all items for total count and reviewer status
    const { data: allItems, error: allError } = await supabase
      .from('enforcement_queue')
      .select('reviewer_status, status')
      .not('reviewer_status', 'is', null);

    if (allError) {
      logError('Failed to fetch all enforcement items', allError, {
        route: '/api/enforcement/summary',
        category: 'database',
      });
    }

    const rows = (allItems ?? []) as { reviewer_status: string; status: string }[];
    const pending = (pendingItems ?? []) as EnforcementRecommendation[];

    const by_escalation: Record<EscalationLevel, number> = { normal: 0, elevated: 0, urgent: 0, critical: 0 };
    const by_action_type: Record<EnforcementActionType, number> = {
      deduction: 0, payout_hold: 0, account_restriction: 0, escalation: 0, warning: 0,
    };
    const by_violation_type: Record<string, number> = {};
    let total_recommended_amount = 0;
    let oldest_pending_at: string | null = null;

    for (const row of pending) {
      by_escalation[row.escalation_level] = (by_escalation[row.escalation_level] ?? 0) + 1;
      by_action_type[row.action_type] = (by_action_type[row.action_type] ?? 0) + 1;
      by_violation_type[row.violation_type] = (by_violation_type[row.violation_type] ?? 0) + 1;
      total_recommended_amount += row.recommended_amount ?? 0;
      if (!oldest_pending_at || row.created_at < oldest_pending_at) {
        oldest_pending_at = row.created_at;
      }
    }

    const by_reviewer_status: Record<string, number> = {};
    for (const row of rows) {
      by_reviewer_status[row.reviewer_status] = (by_reviewer_status[row.reviewer_status] ?? 0) + 1;
    }

    const data = {
      total_pending: pending.length,
      by_escalation,
      by_action_type,
      by_violation_type,
      total_recommended_amount,
      oldest_pending_at,
      by_reviewer_status,
    };

    return NextResponse.json({ data }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (err) {
    logError('Failed to fetch enforcement summary', err, {
      route: '/api/enforcement/summary',
      category: 'database',
    });
    return NextResponse.json({ error: 'Failed to fetch enforcement summary' }, { status: 500 });
  }
}
