import { z } from 'zod';
import { ALL_PROVIDER_IDS } from '@/lib/providers/registry';
import type { ProviderId } from '@/lib/providers/types';

// z.enum needs a non-empty tuple literal; ALL_PROVIDER_IDS is derived from
// PROVIDER_META so this stays in sync with the provider registry automatically.
export const providerIdSchema = z.enum(ALL_PROVIDER_IDS as [ProviderId, ...ProviderId[]]);

export const upsertConnectionBodySchema = z.object({
  assetClass: z.enum(['forex', 'futures']),
  enabled: z.boolean(),
  apiUrl: z.string().trim().url().max(500).optional(),
  // Free-form: apiKey plus whatever PROVIDER_<ID>_<KEY> extras that provider's
  // adapter reads (SYSTEM_UUID, NAME, PASSWORD, APP_ID, ...). Values only —
  // never logged, always envelope-encrypted before it touches the database.
  secrets: z.record(z.string().max(4000)).default({}),
});
