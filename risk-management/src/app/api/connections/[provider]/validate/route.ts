import { NextRequest, NextResponse } from 'next/server';
import { DEMO_MODE } from '@/lib/demo';
import { requireRiskManager } from '@/lib/auth/guards';
import { recordValidationResult } from '@/lib/connections/store';
import { providerIdSchema } from '@/lib/connections/schemas';
import { ADAPTERS } from '@/lib/providers/adapters';

export const dynamic = 'force-dynamic';

/**
 * POST /api/connections/:provider/validate — test-call the provider with this
 * tenant's saved credentials and record the result. `listAccounts` is used as
 * the smoke test across every adapter (every provider implements it, unlike
 * getAccount/enforce which are conditional), so this never needs a per-
 * provider special case.
 */
export async function POST(_request: NextRequest, { params }: { params: { provider: string } }) {
  if (DEMO_MODE)
    return NextResponse.json({ ok: true, demo: true, message: 'Demo: nothing to validate against.' });

  const auth = await requireRiskManager();
  if (!auth.ok) return auth.response;

  const parsedProvider = providerIdSchema.safeParse(params.provider);
  if (!parsedProvider.success) return NextResponse.json({ error: 'Unknown provider' }, { status: 404 });
  const providerId = parsedProvider.data;

  const adapter = ADAPTERS[providerId];

  if (!(await adapter.isConfigured(auth.tenantId))) {
    const message = 'No credentials saved for this provider yet.';
    await recordValidationResult(auth.tenantId, providerId, { ok: false, error: message }).catch(() => {});
    return NextResponse.json({ ok: false, message }, { status: 400 });
  }

  try {
    await adapter.listAccounts(auth.tenantId);
    await recordValidationResult(auth.tenantId, providerId, { ok: true });
    return NextResponse.json({ ok: true, message: `${adapter.meta.label} credentials validated.` });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Validation call failed';
    await recordValidationResult(auth.tenantId, providerId, { ok: false, error: message }).catch(() => {});
    return NextResponse.json({ ok: false, message }, { status: 502 });
  }
}
