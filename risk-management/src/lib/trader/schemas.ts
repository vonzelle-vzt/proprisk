import { z } from 'zod';

// Local to src/lib/trader — mirrors src/lib/tenancy/schemas.ts, which keeps
// its own schemas rather than growing src/lib/api/schemas.ts, an existing
// shared file outside this feature's scope.

export const revokeTraderLinkQuerySchema = z.object({
  id: z.string().uuid(),
});

export const createTraderLinkBodySchema = z.object({
  ttlDays: z.number().int().min(1).max(365).optional(),
});
