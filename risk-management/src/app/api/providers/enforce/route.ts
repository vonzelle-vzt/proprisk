export const dynamic = 'force-dynamic';

import { DEMO_MODE } from '@/lib/demo';
import { requireRiskManager } from '@/lib/auth/guards';
import { ADAPTERS } from '@/lib/providers/adapters';
import { PROVIDER_META } from '@/lib/providers/registry';
import { FOREX_ACCOUNTS } from '@/lib/mock/dataset.forex';
import { FUTURES_ACCOUNTS } from '@/lib/mock/dataset.futures';
import type { ProviderId } from '@/lib/providers/types';
import type { EnforcementAction } from '@/lib/providers/interface';
import { invalidate } from '@/lib/cache/provider-cache';

const VALID_ACTIONS: EnforcementAction[] = ['restrict', 'suspend', 'flatten', 'activate'];

/**
 * POST /api/providers/enforce — run an enforcement action on a trader account
 * via the owning platform adapter. Body: { accountId, action, providerId? }.
 * Resolves the provider from the account when not supplied. In DEMO_MODE the
 * adapter returns a mock success; live, it calls the platform's enforce API
 * (TradeLocker restrict/suspend, Tradovate/Rithmic/CQG risk params, etc.).
 */
export async function POST(request: Request) {
  // Demo flows through the adapter's stub path (mock success); live
  // enforcement is restricted to risk_manager/admin.
  if (!DEMO_MODE) {
    const auth = await requireRiskManager();
    if (!auth.ok) return auth.response;
  }

  const body = await request.json().catch(() => ({}));
  const action = body?.action as EnforcementAction;
  const accountId = String(body?.accountId || '');
  if (!VALID_ACTIONS.includes(action)) {
    return Response.json({ ok: false, message: `Invalid action "${action}".` }, { status: 400 });
  }

  // Resolve provider: explicit, or from the account in the demo dataset.
  let providerId = body?.providerId as ProviderId | undefined;
  if (!providerId) {
    const acct = [...FOREX_ACCOUNTS, ...FUTURES_ACCOUNTS].find((a) => a.accountId === accountId);
    providerId = (acct?.provider as ProviderId) || undefined;
  }
  if (!providerId || !PROVIDER_META[providerId]) {
    return Response.json({ ok: false, message: 'Could not resolve a platform for this account.' }, { status: 404 });
  }

  const adapter = ADAPTERS[providerId];
  if (!adapter.enforce) {
    return Response.json(
      { ok: false, message: `${PROVIDER_META[providerId].label} does not support enforcement actions.` },
      { status: 400 }
    );
  }

  const result = await adapter.enforce(accountId, action);

  // Enforcement changes account state — invalidate cached violation/deduction
  // scans so the next fetch reflects it. Best-effort: never fail the
  // already-succeeded enforcement action over a cache-invalidation error.
  try {
    await invalidate('provider:violations');
    await invalidate('provider:deductions');
  } catch (err) {
    console.error('[enforce] cache invalidation failed', err);
  }

  return Response.json({ ...result, provider: providerId, providerLabel: PROVIDER_META[providerId].label, action });
}
