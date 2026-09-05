export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { RULE_PACK_PRESETS } from '@/lib/rulepack/presets';
import { DEMO_MODE } from '@/lib/demo';

/**
 * The preset catalog. Read-only reference data, not tenant-scoped — every
 * firm sees the same starting shapes and picks one as the first step of the
 * wizard.
 */
export async function GET() {
  if (!DEMO_MODE) {
    const auth = await requireRiskUser();
    if (!auth.ok) return auth.response;
  }

  return NextResponse.json({
    data: RULE_PACK_PRESETS.map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      assetClass: p.assetClass,
      pack: p.pack,
    })),
  });
}
