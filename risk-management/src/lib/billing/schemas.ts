import { z } from 'zod';

// Local to src/lib/billing — mirrors the pattern src/lib/tenancy/schemas.ts
// already established for keeping a feature's request schemas next to it
// rather than growing the shared src/lib/api/schemas.ts.

// Enterprise has no self-serve price (see plans.ts) — it is contact-sales
// only, so it is deliberately not a checkout option here.
export const checkoutBodySchema = z.object({
  planTier: z.enum(['starter', 'growth', 'scale']),
});
