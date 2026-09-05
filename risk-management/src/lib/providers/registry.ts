import type { AssetClass, ProviderId } from './types';
import type { ProviderMeta } from './interface';
import { DEMO_MODE } from '@/lib/demo';
import { getDecryptedConfig } from '@/lib/connections/store';

/**
 * Static metadata for every supported platform, grounded in the integration
 * research. `manager: true` = one credential monitors the whole firm; `false`
 * = per-trader access (collect keys). `kind` = whether the platform computes
 * violations server-side ('native-violations') or we compute them ('raw-data').
 */
export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  // ---- Forex ----
  matchtrader: {
    id: 'matchtrader',
    label: 'MatchTrader',
    assetClass: 'forex',
    kind: 'native-violations',
    manager: true,
    transport: 'REST + gRPC (Broker API / prop-edge)',
    docsUrl: 'https://docs.match-trade.com/docs/broker-api/',
  },
  dxtrade: {
    id: 'dxtrade',
    label: 'DXtrade',
    assetClass: 'forex',
    kind: 'raw-data',
    manager: true,
    transport: 'REST + WebSocket (Admin / B2B / Push API)',
    docsUrl: 'https://demo.dx.trade/developers/',
  },
  tradelocker: {
    id: 'tradelocker',
    label: 'TradeLocker',
    assetClass: 'forex',
    kind: 'raw-data',
    manager: true,
    transport: 'REST + Socket.IO (Brand API / BrandSocket)',
    docsUrl: 'https://brand-docs.tradelocker.com/',
  },
  ctrader: {
    id: 'ctrader',
    label: 'cTrader',
    assetClass: 'forex',
    kind: 'raw-data',
    manager: false, // Open API is per-trader OAuth; manager view needs cServer
    transport: 'Protobuf over TCP/WebSocket (Open API)',
    docsUrl: 'https://help.ctrader.com/open-api/',
  },
  metatrader: {
    id: 'metatrader',
    label: 'MetaTrader 4/5',
    assetClass: 'forex',
    kind: 'raw-data',
    manager: true, // native Manager API (pumping mode) or MetaApi bridge
    transport: 'Manager API (native DLL) / MetaApi cloud bridge',
    docsUrl: 'https://metaapi.cloud/docs/',
  },
  // ---- Futures ----
  tradovate: {
    id: 'tradovate',
    label: 'Tradovate',
    assetClass: 'futures',
    kind: 'native-violations',
    manager: true,
    transport: 'REST + WebSocket (Partner API)',
    docsUrl: 'https://partner.tradovate.com/',
  },
  rithmic: {
    id: 'rithmic',
    label: 'Rithmic',
    assetClass: 'futures',
    kind: 'native-violations',
    manager: true,
    transport: 'Protocol Buffers over WebSocket (R | Protocol, RMS)',
    docsUrl: 'https://www.rithmic.com/apis',
  },
  topstepx: {
    id: 'topstepx',
    label: 'TopstepX (ProjectX)',
    assetClass: 'futures',
    kind: 'raw-data',
    manager: false, // per-trader API key; firm-wide feed not public
    transport: 'REST + SignalR (ProjectX Gateway)',
    docsUrl: 'https://gateway.docs.projectx.com/',
  },
  cqg: {
    id: 'cqg',
    label: 'CQG',
    assetClass: 'futures',
    kind: 'raw-data',
    manager: true, // PUBLICATION_TYPE_ALL_AUTHORIZED
    transport: 'Protobuf over WSS (WebAPI)',
    docsUrl: 'https://help.cqg.com/apihelp/',
  },
  ninjatrader: {
    id: 'ninjatrader',
    label: 'NinjaTrader',
    assetClass: 'futures',
    kind: 'raw-data',
    manager: false, // desktop ATI is local-only; cloud path IS Tradovate
    transport: 'Local ATI/NinjaScript (cloud = Tradovate)',
    docsUrl: 'https://ninjatrader.com/support/helpguides/nt8/',
  },
};

export const ALL_PROVIDER_IDS = Object.keys(PROVIDER_META) as ProviderId[];

/**
 * Env-config convention: PROVIDER_<ID>_ENABLED / _API_URL / _API_KEY, plus a
 * free-form `extra` bag for provider-specific vars (PROVIDER_<ID>_<KEY>), e.g.
 * MatchTrader's SYSTEM_UUID or Tradovate's APP_ID/CID/SEC/NAME/PASSWORD.
 */
export interface ProviderConfig {
  id: ProviderId;
  enabled: boolean;
  apiUrl?: string;
  apiKey?: string;
  extra: Record<string, string | undefined>;
}

function envFor(id: ProviderId): ProviderConfig {
  const U = id.toUpperCase();
  const prefix = `PROVIDER_${U}_`;
  const extra: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(prefix)) {
      extra[key.slice(prefix.length)] = process.env[key];
    }
  }
  return {
    id,
    enabled: process.env[`${prefix}ENABLED`] === 'true',
    apiUrl: process.env[`${prefix}API_URL`],
    apiKey: process.env[`${prefix}API_KEY`],
    extra,
  };
}

/**
 * Resolve provider config. Two overloads, one function:
 *  - `getProviderConfig(id)` — legacy env-based lookup, synchronous. Kept
 *    exactly as-is (same signature, same return type) so every existing
 *    call site — including code outside this refactor's scope — keeps
 *    compiling and behaving identically.
 *  - `getProviderConfig(id, tenantId)` — per-tenant lookup from the
 *    `connections` table (src/lib/connections/store.ts), async because it's
 *    a database read. Falls back to the env-based config when the tenant
 *    has no connection row yet, so a freshly onboarded tenant isn't hard-
 *    broken before they've filled in the Connections page.
 */
export function getProviderConfig(id: ProviderId): ProviderConfig;
export function getProviderConfig(id: ProviderId, tenantId: string): Promise<ProviderConfig>;
export function getProviderConfig(id: ProviderId, tenantId?: string): ProviderConfig | Promise<ProviderConfig> {
  if (tenantId === undefined) return envFor(id);
  return resolveTenantProviderConfig(id, tenantId);
}

async function resolveTenantProviderConfig(id: ProviderId, tenantId: string): Promise<ProviderConfig> {
  // DEMO_MODE never reaches a real database (createAdminClient throws), and
  // every demo route already short-circuits before touching a provider.
  if (DEMO_MODE) return envFor(id);

  const conn = await getDecryptedConfig(tenantId, id);
  if (!conn) return envFor(id);

  const { apiKey, ...extra } = conn.secrets;
  return { id, enabled: conn.enabled, apiUrl: conn.apiUrl, apiKey, extra };
}

export function metaForAssetClass(assetClass: AssetClass): ProviderMeta[] {
  return ALL_PROVIDER_IDS.map((id) => PROVIDER_META[id]).filter(
    (m) => m.assetClass === assetClass
  );
}

/** Provider ids configured (real creds present) for an asset class. */
export function getConfiguredProviderIds(assetClass: AssetClass): ProviderId[] {
  return metaForAssetClass(assetClass)
    .filter((m) => envFor(m.id).enabled)
    .map((m) => m.id);
}

/** Default provider for an asset class (MatchTrader for forex, Tradovate for futures). */
export function getDefaultProviderId(assetClass: AssetClass): ProviderId {
  return assetClass === 'futures' ? 'tradovate' : 'matchtrader';
}
