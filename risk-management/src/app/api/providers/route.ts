export const dynamic = 'force-dynamic';

import { DEMO_MODE } from '@/lib/demo';
import { ALL_PROVIDER_IDS, PROVIDER_META, getProviderConfig } from '@/lib/providers/registry';
import { ADAPTERS } from '@/lib/providers/adapters';

/**
 * GET /api/providers — platform integration health for the Connections page.
 * Returns every supported provider with its connection status, asset class,
 * manager-vs-per-trader capability, and (in demo) a monitored-account count.
 */
export async function GET() {
  const providers = await Promise.all(
    ALL_PROVIDER_IDS.map(async (id) => {
      const meta = PROVIDER_META[id];
      const cfg = getProviderConfig(id);
      // In demo mode everything reads "demo" (nothing is actually wired to a
      // live API). Outside demo, a configured provider is "live".
      const status = DEMO_MODE ? 'demo' : cfg.enabled ? 'live' : 'not_configured';

      let accountCount = 0;
      if (status !== 'not_configured') {
        try {
          accountCount = (await ADAPTERS[id].listAccounts()).length;
        } catch {
          accountCount = 0;
        }
      }

      return {
        id: meta.id,
        label: meta.label,
        assetClass: meta.assetClass,
        kind: meta.kind,
        manager: meta.manager,
        transport: meta.transport,
        docsUrl: meta.docsUrl,
        status,
        accountCount,
        canEnforce: typeof ADAPTERS[id].enforce === 'function',
        lastSync: status === 'not_configured' ? null : new Date().toISOString(),
      };
    })
  );

  return Response.json({ providers, demo: DEMO_MODE });
}
