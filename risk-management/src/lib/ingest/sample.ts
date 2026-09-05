import { tenantDb } from '@/lib/db/tenant-scoped';
import { ADAPTERS } from '@/lib/providers/adapters';
import { metaForAssetClass } from '@/lib/providers/registry';
import { mapConcurrent } from '@/lib/providers/adapters/http';
import type { TradingProvider } from '@/lib/providers/interface';
import type { AssetClass } from '@/lib/providers/types';
import { logError } from '@/lib/logging/logger';
import { pruneSnapshots, recordSnapshots, type SnapshotWriteInput } from './snapshots';

/**
 * Pull path: sample balance/equity for one tenant's accounts via the
 * provider adapters' existing `getBalanceEquity`. Called per tenant by
 * src/app/api/cron/sample-equity through `fanOutToTenants`, which already
 * bounds how many tenants run at once (docs/HOW-IT-WORKS.md §Flow 2). This
 * module bounds the OTHER axis: how many of one tenant's accounts are
 * in flight at once, so a firm with 5,000 accounts doesn't hold every
 * worker slot in the `maxDuration` window and starve the tenants after it
 * in the fan-out.
 *
 * SAMPLING INTERVAL: this cron's own invocation cadence (set in vercel.json's
 * `crons` — not touched here, see report) is the real interval; this module
 * only records what it's CONFIGURED to be, via EQUITY_SAMPLE_INTERVAL_SECONDS
 * (default 300s / 5 minutes). That is a fidelity/rate-limit trade-off, not a
 * technical constant: every account this samples costs one balance-lookup
 * call against that tenant's own provider connection, so tightening it is a
 * per-tenant rate-limit decision, which is exactly why it's an env var and
 * not a literal. Apex-style intraday-trailing floors move on ticks a 5-minute
 * poll cannot see — that gap is recorded per-row (`sample_interval_seconds`,
 * see the migration) rather than hidden, so a breach built from these
 * snapshots can say what it could and couldn't have seen.
 */

const DEFAULT_SAMPLE_INTERVAL_SECONDS = 300;
const DEFAULT_ACCOUNT_CONCURRENCY = 10;
const DEFAULT_RETENTION_DAYS = 7;

function sampleIntervalSeconds(): number {
  const raw = Number(process.env.EQUITY_SAMPLE_INTERVAL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SAMPLE_INTERVAL_SECONDS;
}

function accountConcurrency(): number {
  const raw = Number(process.env.EQUITY_SAMPLE_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ACCOUNT_CONCURRENCY;
}

function retentionDays(): number {
  const raw = Number(process.env.EQUITY_SNAPSHOT_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
}

/**
 * Every adapter configured for this tenant, across both asset classes.
 * Deliberately NOT `getActiveProviders` (src/lib/providers/adapters/index.ts)
 * — that helper checks the legacy env-based `getConfiguredProviderIds`, which
 * is not tenant-aware and would sample under the wrong (or nobody's) creds
 * for a tenant whose provider lives in the per-tenant `connections` table.
 * `isConfigured(tenantId)` is the per-tenant check every adapter already
 * implements (src/lib/providers/interface.ts).
 */
async function resolveConfiguredProviders(tenantId: string): Promise<TradingProvider[]> {
  const assetClasses: AssetClass[] = ['forex', 'futures'];
  const providers: TradingProvider[] = [];

  for (const assetClass of assetClasses) {
    for (const meta of metaForAssetClass(assetClass)) {
      const provider = ADAPTERS[meta.id];
      if (await provider.isConfigured(tenantId)) providers.push(provider);
    }
  }

  return providers;
}

interface AccountRow {
  id: string;
  login: string;
}

export interface SampleTenantResult {
  accounts_considered: number;
  sampled: number;
  no_provider: number;
  provider_errors: number;
  pruned: boolean;
}

/**
 * Sample every active account for one tenant, write what came back, and
 * prune anything past the retention window. A tenant with no configured
 * provider is not an error — it just has nothing to sample yet (e.g. mid
 * onboarding) — and is reported as such via `no_provider` rather than
 * thrown.
 */
export async function sampleTenant(tenantId: string): Promise<SampleTenantResult> {
  const db = tenantDb(tenantId, 'sample-equity');
  const result: SampleTenantResult = {
    accounts_considered: 0,
    sampled: 0,
    no_provider: 0,
    provider_errors: 0,
    pruned: false,
  };

  const providers = await resolveConfiguredProviders(tenantId);
  if (providers.length === 0) {
    result.pruned = await pruneSnapshots(tenantId, retentionDays());
    return result;
  }

  const { data: accounts, error } = await db
    .select('accounts', 'id, login')
    .eq('is_active', true)
    .returns<AccountRow[]>();
  if (error) throw error;

  const rows = accounts ?? [];
  result.accounts_considered = rows.length;
  if (rows.length === 0) {
    result.pruned = await pruneSnapshots(tenantId, retentionDays());
    return result;
  }

  const capturedAt = new Date().toISOString();
  const interval = sampleIntervalSeconds();

  const outcomes = await mapConcurrent(
    rows,
    async (account) => {
      for (const provider of providers) {
        try {
          const balanceEquity = await provider.getBalanceEquity(account.login, tenantId);
          if (balanceEquity) {
            const write: SnapshotWriteInput = {
              accountId: account.id,
              capturedAt,
              balance: balanceEquity.balance,
              equity: balanceEquity.equity,
              source: 'poll',
              sampleIntervalSeconds: interval,
            };
            return { ok: true as const, write };
          }
        } catch (err) {
          logError('sample-equity: getBalanceEquity failed', err, {
            category: 'external_api',
            tenant_id: tenantId,
            account_id: account.id,
          });
        }
      }
      return { ok: false as const };
    },
    accountConcurrency()
  );

  const writes: SnapshotWriteInput[] = [];
  for (const outcome of outcomes) {
    if (!outcome) {
      result.provider_errors++;
    } else if (outcome.ok) {
      writes.push(outcome.write);
    } else {
      result.no_provider++;
    }
  }

  if (writes.length > 0) {
    const written = await recordSnapshots(tenantId, writes);
    result.sampled = written.written;
    result.provider_errors += written.failed;
  }

  result.pruned = await pruneSnapshots(tenantId, retentionDays());
  return result;
}
