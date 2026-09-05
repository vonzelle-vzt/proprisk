export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';
import { DEMO_MODE, assetClassFromRequest } from '@/lib/demo';
import { buildReviewerRuns } from '@/lib/mock/builders';

export async function GET(request: NextRequest) {
  if (DEMO_MODE) return NextResponse.json(buildReviewerRuns(assetClassFromRequest(request)));
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('reviewer-runs', { windowMs: 60_000, maxRequests: 30 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const supabase = await createClient();
    const searchParams = request.nextUrl.searchParams;
    const limit = Math.min(Number(searchParams.get('limit') ?? 20), 100);
    const offset = Number(searchParams.get('offset') ?? 0);

    // Fetch reviewer runs
    const { data: runs, error: runsError, count } = await supabase
      .from('reviewer_runs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (runsError) throw runsError;

    // Fetch reviewed cases (most recent 100 with reviewer_status set)
    const { data: cases, error: casesError } = await supabase
      .from('enforcement_queue')
      .select('id, account_id, violation_type, action_type, recommended_amount, status, reviewer_status, reviewer_notes, reviewed_at, created_at, severity_score, escalation_level, recommendation_details, recommendation_reason, prior_violation_count, repeat_multiplier, decided_by, decided_at, execution_result')
      .not('reviewer_status', 'is', null)
      .order('reviewed_at', { ascending: false })
      .limit(100);

    if (casesError) throw casesError;

    // Compute aggregate stats
    const allCases = cases ?? [];
    const stats = {
      total_reviewed: allCases.length,
      confirmed: allCases.filter(c => c.reviewer_status === 'deduction_confirmed').length,
      pending_deduction: allCases.filter(c => c.reviewer_status === 'pending_deduction').length,
      errors: allCases.filter(c => c.reviewer_status === 'review_error').length,
      total_runs: count ?? 0,
      last_run: runs && runs.length > 0 ? runs[0] : null,
    };

    return NextResponse.json({ runs: runs ?? [], cases: allCases, stats }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (err) {
    logError('Failed to fetch reviewer data', err, {
      route: '/api/reviewer/runs',
      category: 'database',
    });
    return NextResponse.json({ error: 'Failed to fetch reviewer data' }, { status: 500 });
  }
}
