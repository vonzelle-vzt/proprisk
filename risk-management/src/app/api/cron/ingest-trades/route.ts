import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { tenantDb } from '@/lib/db/tenant-scoped';
import { classifyAsset } from '@/lib/utils/asset-class';
import { logError } from '@/lib/logging/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Legacy raw trade-feed ingestion. Unlike every other cron here, this isn't
 * naturally "one job per tenant": TRADING_API_URL/TRADING_API_KEY are a
 * single global feed (there's no per-tenant credential store for this path —
 * that's what the provider/adapters system with per-tenant `connections`
 * rows replaced; see src/lib/platform/client.ts). So instead of iterating
 * tenants and re-fetching the same feed N times, this fetches once, then
 * resolves each trade's tenant from its account (a single global lookup —
 * `accounts.id -> tenant_id` is not customer data, just a routing key) and
 * writes through `tenantDb` per tenant. A trade whose account can't be
 * resolved to a tenant is skipped and counted, not silently dropped.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const apiUrl = process.env.TRADING_API_URL;
    const apiKey = process.env.TRADING_API_KEY;

    if (!apiUrl || !apiKey) {
      return NextResponse.json({ message: 'Trading API not configured, skipping ingestion' }, { status: 200 });
    }

    const response = await fetch(`${apiUrl}/trades/recent`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      return NextResponse.json({ error: `Trading API error: ${response.status}` }, { status: 502 });
    }

    const trades = await response.json();

    if (!Array.isArray(trades) || trades.length === 0) {
      return NextResponse.json({ message: 'No new trades to ingest', count: 0 });
    }

    // Resolve tenant ownership for every distinct account in this batch —
    // one query, not one per trade.
    const admin = createAdminClient();
    const accountIds = [...new Set(trades.map((t: any) => t.account_id))];
    const { data: accountRows } = await admin
      .from('accounts')
      .select('id, tenant_id')
      .in('id', accountIds);
    const tenantByAccount = new Map<string, string>(
      (accountRows || []).filter((a: any) => a.tenant_id).map((a: any) => [a.id, a.tenant_id])
    );

    let ingested = 0;
    let skipped = 0;
    let unresolvedTenant = 0;

    for (const trade of trades) {
      const tenantId = tenantByAccount.get(trade.account_id);
      if (!tenantId) {
        unresolvedTenant++;
        continue;
      }

      const db = tenantDb(tenantId, 'ingest-trades');
      const { error } = await db.upsert(
        'trades',
        {
          account_id: trade.account_id,
          trade_id_external: trade.trade_id || trade.ticket,
          symbol: trade.symbol,
          asset_class: classifyAsset(trade.symbol),
          direction: trade.type === 0 || trade.type === 'buy' ? 'buy' : 'sell',
          lot_size: trade.lots || trade.volume,
          open_price: trade.open_price,
          close_price: trade.close_price || null,
          open_time: trade.open_time,
          close_time: trade.close_time || null,
          profit: trade.profit || 0,
          swap: trade.swap || 0,
          commission: trade.commission || 0,
          comment: trade.comment || null,
          magic_number: trade.magic_number || null,
        },
        { onConflict: 'account_id,trade_id_external' }
      );

      if (error) {
        skipped++;
        logError('ingest-trades: trade upsert failed', error, {
          category: 'database',
          tenant_id: tenantId,
          account_id: trade.account_id,
        });
      } else {
        ingested++;
      }
    }

    // Update account balances, per tenant.
    for (const accountId of accountIds) {
      const tenantId = tenantByAccount.get(accountId as string);
      if (!tenantId) continue;

      const balanceRes = await fetch(`${apiUrl}/accounts/${accountId}/balance`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${apiKey}` },
      }).catch(() => null);

      if (balanceRes?.ok) {
        const balanceData = await balanceRes.json();
        await tenantDb(tenantId, 'ingest-trades')
          .update('accounts', {
            balance: balanceData.balance,
            equity: balanceData.equity,
          })
          .eq('id', accountId);
      }
    }

    return NextResponse.json({ message: 'Trade ingestion complete', ingested, skipped, unresolved_tenant: unresolvedTenant });
  } catch (error: any) {
    logError('ingest-trades cron failed', error, { category: 'cron' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
