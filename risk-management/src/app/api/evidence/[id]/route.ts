export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { DEMO_MODE } from '@/lib/demo';
import { requireRiskUser } from '@/lib/auth/guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';
import { createClient } from '@/lib/supabase/server';
import { buildEvidencePack, decodeDemoEvidenceId } from '@/lib/evidence/builder';
import type { EvidencePack } from '@/lib/evidence/types';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;

  if (DEMO_MODE) {
    const decoded = decodeDemoEvidenceId(id);
    if (!decoded) {
      return NextResponse.json({ error: 'Evidence pack not found' }, { status: 404 });
    }
    const pack = await buildEvidencePack(decoded);
    return NextResponse.json({ data: pack });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('evidence-get', { windowMs: 60_000, maxRequests: 60 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const supabase = await createClient();
    const { data: row, error } = await supabase.from('evidence_packs').select('*').eq('id', id).maybeSingle();

    if (error || !row) {
      return NextResponse.json({ error: 'Evidence pack not found' }, { status: 404 });
    }

    const pack: EvidencePack = {
      id: row.id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      accountId: row.account_id,
      assetClass: row.asset_class,
      title: row.title,
      createdAt: row.created_at,
      createdBy: row.created_by,
      narrative: row.narrative,
      sections: row.pack,
    };

    return NextResponse.json({ data: pack });
  } catch (err) {
    logError(`Failed to fetch evidence pack ${id}`, err, {
      route: `/api/evidence/${id}`,
      category: 'database',
    });
    return NextResponse.json({ error: 'Failed to fetch evidence pack' }, { status: 500 });
  }
}
