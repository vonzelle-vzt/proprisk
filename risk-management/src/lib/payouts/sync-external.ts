import { createAdminClient } from '@/lib/supabase/admin';
import { fetchPendingPayouts } from '@/lib/platform/client';
import { enrichPayouts } from '@/lib/payouts/enrich';
import { savePayoutSnapshot } from '@/lib/payouts/snapshot';
import { buildRecordFromPayout } from '@/lib/payouts/map-payout';
import type { PlatformPayout } from '@/types/platform';
import type { PayoutDecision } from '@/types/history';

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: number;
  remaining: number;
}

/** Map platform payout status to our decision type */
function statusToDecision(status: string): PayoutDecision | null {
  const s = (status || '').toLowerCase().trim();
  if (s === 'approved' || s === 'paid' || s === 'completed' || s === 'pre-approved' || s === 'preapproved') return 'approved';
  if (s === 'rejected' || s === 'declined' || s === 'denied') return 'rejected';
  return null;
}

/** Fetch already-synced (platform_payout_id, decision) pairs from Supabase */
async function getExistingSyncedKeys(): Promise<Set<string>> {
  const sb = createAdminClient();
  const { data, error } = await sb
    .from('payout_history')
    .select('platform_payout_id, decision');

  if (error || !data) return new Set();
  return new Set(data.map((r: { platform_payout_id: string; decision: string }) => `${r.platform_payout_id}:${r.decision}`));
}

// Max payouts to enrich + save per sync call to avoid Vercel timeout (10s Hobby).
// Each payout makes 3 provider platform API calls for enrichment at concurrency 5,
// so 20 payouts ≈ 4 batches ≈ ~4 seconds.
const MAX_SYNC_BATCH = 20;

/**
 * Fetch recently-decided payouts from the provider platform that are not yet in Supabase,
 * enrich them, and save snapshots. Processes up to MAX_SYNC_BATCH per call
 * to avoid timeout. Returns `remaining` count so the client can call again.
 */
export async function syncExternalPayouts(tenantId: string): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, skipped: 0, errors: 0, remaining: 0 };

  // Fetch decided payouts from the provider platform.
  // Use dateField + date range to ensure decided payouts are returned.
  const dateParams = {
    dateField: 'statusChanged',
    from: '20240101',
    to: '20270101',
  };

  const [approvedPayouts, rejectedPayouts] = await Promise.all([
    fetchPendingPayouts({
      statuses: ['Approved', 'Paid'],
      ...dateParams,
      limit: 1000,
    }, tenantId),
    fetchPendingPayouts({
      statuses: ['Rejected'],
      ...dateParams,
      limit: 1000,
    }, tenantId),
  ]);

  const allDecided = [...approvedPayouts, ...rejectedPayouts];
  if (allDecided.length === 0) return result;

  // Deduplicate by _id
  const payoutMap = new Map<string, PlatformPayout>();
  for (const p of allDecided) {
    if (p._id && !payoutMap.has(p._id)) payoutMap.set(p._id, p);
  }

  // Filter out payouts already in Supabase
  const existingKeys = await getExistingSyncedKeys();
  const toSync: PlatformPayout[] = [];

  for (const [id, payout] of payoutMap) {
    const decision = statusToDecision(payout.status || '');
    if (!decision) continue;

    const key = `${id}:${decision}`;
    if (existingKeys.has(key)) {
      result.skipped++;
    } else {
      toSync.push(payout);
    }
  }

  if (toSync.length === 0) return result;

  // Process only a batch to stay within timeout limits
  const batch = toSync.slice(0, MAX_SYNC_BATCH);
  result.remaining = Math.max(0, toSync.length - MAX_SYNC_BATCH);

  // Convert to PayoutRecord and enrich
  const records = batch.map(buildRecordFromPayout);
  const enriched = await enrichPayouts(records, tenantId);

  // Save each enriched record
  for (let i = 0; i < enriched.length; i++) {
    const payout = batch[i];
    const record = enriched[i];
    const decision = statusToDecision(payout.status || '');
    if (!decision) continue;

    const decidedAt = payout.statusChanged || payout.updated || new Date().toISOString();
    const notes = payout.rejectionMessage
      ? `External rejection: ${payout.rejectionMessage}`
      : 'Synced from the provider platform — decided externally';

    try {
      await savePayoutSnapshot(record, decision, 'Platform Dashboard', notes, decidedAt);
      result.synced++;
    } catch {
      result.errors++;
    }
  }

  return result;
}
