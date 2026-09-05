export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { approveRecommendation, rejectRecommendation } from '@/lib/enforcement/queue-manager';
import { requireRiskManager } from '@/lib/auth/guards';
import { createClient } from '@/lib/supabase/server';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';
import { DEMO_MODE } from '@/lib/demo';

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;

  if (DEMO_MODE) {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json({ data: { id, status: body?.decision === 'rejected' ? 'rejected' : 'approved', decided_by: body?.decided_by ?? 'Risk Analyst' } });
  }

  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('enforcement-decide', { windowMs: 60_000, maxRequests: 30 });
  if (!rl.allowed) return rateLimitResponse(rl);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { decision, decided_by, notes } = body;

  if (!decision || !['approved', 'rejected'].includes(decision)) {
    return NextResponse.json(
      { error: 'decision must be "approved" or "rejected"' },
      { status: 400 }
    );
  }

  if (!decided_by || typeof decided_by !== 'string') {
    return NextResponse.json(
      { error: 'decided_by is required and must be a string' },
      { status: 400 }
    );
  }

  try {
    const result =
      decision === 'approved'
        ? await approveRecommendation(id, decided_by, auth.tenantId, notes)
        : await rejectRecommendation(id, decided_by, notes);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || `Recommendation could not be ${decision}` },
        { status: 409 }
      );
    }

    return NextResponse.json({ data: result });
  } catch (err) {
    logError(`Failed to ${decision} recommendation ${id}`, err, {
      route: `/api/enforcement/queue/${id}`,
      category: 'database',
    });
    return NextResponse.json(
      { error: `Failed to ${decision} recommendation: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}

/**
 * DELETE handler to clean up duplicate enforcement queue items.
 * Keeps only the latest pending item per account_id + violation_type.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;

  if (DEMO_MODE) {
    return NextResponse.json({ error: 'Not available in demo mode' }, { status: 403 });
  }

  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

  // Special: if id is "cleanup-duplicates", remove all dupes
  if (id === 'cleanup-duplicates') {
    const supabase = await createClient();
    const { data: allItems } = await supabase
      .from('enforcement_queue')
      .select('id, account_id, violation_type, status, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (!allItems || allItems.length === 0) {
      return NextResponse.json({ message: 'No pending items', deleted: 0 });
    }

    const keep = new Map<string, string>();
    const deleteIds: string[] = [];

    for (const item of allItems) {
      const key = `${item.account_id}_${item.violation_type}`;
      if (!keep.has(key)) {
        keep.set(key, item.id);
      } else {
        deleteIds.push(item.id);
      }
    }

    if (deleteIds.length > 0) {
      const { error } = await supabase
        .from('enforcement_queue')
        .delete()
        .in('id', deleteIds);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }

    return NextResponse.json({
      message: 'Cleanup complete',
      total: allItems.length,
      kept: keep.size,
      deleted: deleteIds.length,
    });
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}
