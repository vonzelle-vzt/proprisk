export const dynamic = 'force-dynamic';

import { DEMO_MODE } from '@/lib/demo';
import { buildExposure } from '@/lib/mock/builders';
import { getActiveProviders } from '@/lib/providers/adapters';

/**
 * GET /api/exposure — firm-wide exposure across BOTH asset classes at once
 * (the "Forex + Futures on one dashboard" headline). Demo returns combined
 * mock totals; live mode would aggregate `listAccounts()`/`getBalanceEquity()`
 * across every active provider for both classes.
 */
export async function GET() {
  if (DEMO_MODE) return Response.json(buildExposure());

  // Live: aggregate across active providers for both asset classes.
  const [forexProviders, futuresProviders] = [getActiveProviders('forex'), getActiveProviders('futures')];
  void forexProviders;
  void futuresProviders;
  // TODO: sum normalized balances/breaches across providers.
  return Response.json({
    byAssetClass: {
      forex: { accounts: 0, openExposure: 0, payoutsPending: 0, accountsInBreach: 0, totalDeductions: 0 },
      futures: { accounts: 0, openExposure: 0, payoutsPending: 0, accountsInBreach: 0, totalDeductions: 0 },
    },
    combined: { accounts: 0, openExposure: 0, payoutsPending: 0, accountsInBreach: 0, totalDeductions: 0 },
  });
}
