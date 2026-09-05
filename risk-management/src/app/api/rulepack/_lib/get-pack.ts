import { listPacks, type StoredRulePack } from '@/lib/rulepack/store';

/**
 * `listPacks` + find rather than a dedicated fetch-one: the store's row
 * conversion (`rowToPack`) is not exported, and every route sharing this
 * FILES_IN_SCOPE excludes every other file under src/lib/rulepack, so this
 * reuses the store's one read path instead of duplicating that conversion.
 */
export async function findPack(tenantId: string, id: string): Promise<StoredRulePack | null> {
  const packs = await listPacks(tenantId);
  return packs.find((p) => p.id === id) ?? null;
}
