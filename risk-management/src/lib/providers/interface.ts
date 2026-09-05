import type {
  AssetClass,
  NormalizedAccount,
  NormalizedPayout,
  NormalizedTrade,
  NormalizedUser,
  NormalizedViolation,
  ProviderId,
  ProviderKind,
} from './types';

/** Thrown by adapters when a real (non-demo) call is attempted without creds. */
export class NotConfiguredError extends Error {
  constructor(provider: ProviderId) {
    super(
      `Provider "${provider}" is not configured. Set PROVIDER_${provider.toUpperCase()}_ENABLED=true ` +
        `and supply credentials, then implement the live calls in its adapter.`
    );
    this.name = 'NotConfiguredError';
  }
}

export interface ProviderMeta {
  id: ProviderId;
  /** Display name shown in UI chips / the Integrations page. */
  label: string;
  assetClass: AssetClass;
  /** Whether the platform computes violations server-side or we compute them. */
  kind: ProviderKind;
  /**
   * `true` if one credential set can enumerate & monitor the whole firm (a
   * manager/broker feed); `false` if access is per-trader (must collect keys).
   */
  manager: boolean;
  /** Transport, for the Integrations page tooltip. */
  transport: string;
  /** Real API docs base URL, for reference in the adapter + UI. */
  docsUrl: string;
}

export type EnforcementAction = 'restrict' | 'suspend' | 'flatten' | 'activate';

/**
 * The contract every platform adapter implements. Methods return normalized
 * types so the dashboard/risk engine never sees a platform's native shape.
 *
 * In DEMO_MODE (or when `isConfigured()` is false) adapters return mock data;
 * once configured + live they call the real API (the `TODO: live call` blocks).
 *
 * Every method takes an optional trailing `tenantId`. When supplied, the
 * adapter resolves credentials (and, for adapters with an auth-token cache,
 * the cached token) for THAT tenant only — see registry.ts:getProviderConfig
 * and each adapter's per-tenant cache. When omitted, the adapter falls back
 * to the legacy env-based global config, so existing single-tenant call
 * sites keep working unchanged while the app migrates to always passing a
 * tenant id.
 */
export interface TradingProvider {
  readonly meta: ProviderMeta;

  /** Are real credentials present (env, or this tenant's connection)? */
  isConfigured(tenantId?: string): Promise<boolean>;

  listAccounts(tenantId?: string): Promise<NormalizedAccount[]>;
  /** Single-account lookup (efficient per-account detail without listing all). */
  getAccount?(accountId: string, tenantId?: string): Promise<NormalizedAccount | null>;
  getUser(userId: string, tenantId?: string): Promise<NormalizedUser | null>;
  getBalanceEquity(accountId: string, tenantId?: string): Promise<{ balance: number; equity: number } | null>;
  getOpenPositions(accountId: string, tenantId?: string): Promise<NormalizedTrade[]>;
  getClosedTradeHistory(accountId: string, tenantId?: string): Promise<NormalizedTrade[]>;
  getPayouts(tenantId?: string): Promise<NormalizedPayout[]>;
  /**
   * Native-violation providers return server-computed breaches; raw-data
   * providers return [] and rely on the forex/futures risk engine instead.
   */
  getRiskViolations(accountId: string, tenantId?: string): Promise<NormalizedViolation[]>;

  /** Optional — present only where the platform API supports enforcement. */
  enforce?(accountId: string, action: EnforcementAction, tenantId?: string): Promise<{ ok: boolean; message: string }>;
}
