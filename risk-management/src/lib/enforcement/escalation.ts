import { tenantDb } from '@/lib/db/tenant-scoped';
import { logInfo, logError } from '@/lib/logging/logger';
import type { EnforcementRecommendation, EscalationLevel } from '@/types/enforcement';

const ESCALATION_ORDER: EscalationLevel[] = ['normal', 'elevated', 'urgent', 'critical'];

function nextLevel(current: EscalationLevel): EscalationLevel {
  const idx = ESCALATION_ORDER.indexOf(current);
  if (idx < 0 || idx >= ESCALATION_ORDER.length - 1) return 'critical';
  return ESCALATION_ORDER[idx + 1];
}

/**
 * Time thresholds for automatic escalation (in milliseconds).
 * normal pending >12h  -> elevated
 * elevated pending >4h -> urgent
 * urgent pending >1h   -> critical
 */
const TIME_THRESHOLDS: Record<EscalationLevel, number> = {
  normal: 12 * 60 * 60 * 1000,
  elevated: 4 * 60 * 60 * 1000,
  urgent: 1 * 60 * 60 * 1000,
  critical: Infinity, // already at max
};

/**
 * Auto-escalate pending enforcement queue items based on time, volume,
 * and amount rules. Returns the count of escalated items.
 *
 * `tenantId` is required — this is a background job (see
 * /api/cron/enforce), and `createAdminClient()` used directly here would
 * escalate every tenant's queue against every other tenant's volume/amount
 * thresholds (src/lib/db/tenant-scoped.ts).
 */
export async function autoEscalate(tenantId: string): Promise<number> {
  const db = tenantDb(tenantId, 'autoEscalate');
  const now = Date.now();

  // `tenantDb().select()` takes `table` as a bare `string`, so Postgrest
  // falls back to `GenericStringError` instead of a real row shape —
  // `.returns<T>()` restores it (see also src/lib/violations/worker.ts).
  const { data: pending, error } = await db
    .select('enforcement_queue', '*')
    .eq('status', 'pending')
    .returns<EnforcementRecommendation[]>();

  if (error) {
    logError('Failed to fetch pending items for escalation', error, { category: 'database' });
    return 0;
  }

  const rows = pending ?? [];
  if (rows.length === 0) return 0;

  const toEscalate = new Map<string, EscalationLevel>(); // id -> new level

  // --- Time-based escalation ---
  for (const row of rows) {
    if (row.escalation_level === 'critical') continue;
    const threshold = TIME_THRESHOLDS[row.escalation_level];
    const age = now - new Date(row.created_at).getTime();
    if (age > threshold) {
      const newLevel = nextLevel(row.escalation_level);
      toEscalate.set(row.id, newLevel);
    }
  }

  // --- Volume-based: 3+ pending for one account -> all to urgent (at least) ---
  const byAccount = new Map<string, EnforcementRecommendation[]>();
  for (const row of rows) {
    const list = byAccount.get(row.account_id) ?? [];
    list.push(row);
    byAccount.set(row.account_id, list);
  }

  for (const [, accountRows] of byAccount) {
    if (accountRows.length >= 3) {
      for (const row of accountRows) {
        const currentTarget = toEscalate.get(row.id);
        const currentLevel = currentTarget ?? row.escalation_level;
        const urgentIdx = ESCALATION_ORDER.indexOf('urgent');
        const currentIdx = ESCALATION_ORDER.indexOf(currentLevel);
        if (currentIdx < urgentIdx) {
          toEscalate.set(row.id, 'urgent');
        }
      }
    }
  }

  // --- Amount-based: total recommended_amount >$1000 for one account -> critical ---
  for (const [, accountRows] of byAccount) {
    const totalAmount = accountRows.reduce((s, r) => s + (r.recommended_amount ?? 0), 0);
    if (totalAmount > 1000) {
      for (const row of accountRows) {
        toEscalate.set(row.id, 'critical');
      }
    }
  }

  // Apply escalations
  let escalatedCount = 0;
  const nowIso = new Date().toISOString();

  for (const [id, newLevel] of toEscalate) {
    const row = rows.find((r) => r.id === id);
    if (!row || row.escalation_level === newLevel) continue;

    // Only escalate upward
    const currentIdx = ESCALATION_ORDER.indexOf(row.escalation_level);
    const newIdx = ESCALATION_ORDER.indexOf(newLevel);
    if (newIdx <= currentIdx) continue;

    const { error: updateError } = await db
      .update('enforcement_queue', {
        escalation_level: newLevel,
        status: 'auto_escalated',
        escalated_at: nowIso,
        escalated_from: row.escalation_level,
        updated_at: nowIso,
      })
      .eq('id', id);

    if (updateError) {
      logError('Failed to escalate recommendation', updateError, {
        category: 'database',
        account_id: row.account_id,
      });
      continue;
    }

    escalatedCount++;
  }

  if (escalatedCount > 0) {
    logInfo(`Auto-escalated ${escalatedCount} enforcement recommendations`, {
      category: 'internal',
    });
  }

  return escalatedCount;
}
