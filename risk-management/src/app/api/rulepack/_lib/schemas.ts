import { z } from 'zod';

/**
 * Request-body validation for the rule pack routes.
 *
 * These deliberately do NOT re-validate against `rulePackSchema` — the store's
 * `createDraft`/`updateDraft` already do that and throw `PackValidationError`
 * with customer-facing messages. Schemas here only guard the shapes the store
 * does not see: preset selection and backtest inputs.
 */

export const createDraftBodySchema = z
  .object({
    from_preset: z.string().trim().min(1).max(60).optional(),
    pack: z.unknown().optional(),
  })
  .refine((v) => v.from_preset !== undefined || v.pack !== undefined, {
    message: 'Provide either from_preset or pack',
  });

export const updateDraftBodySchema = z.object({
  pack: z.unknown(),
});

export const activateBodySchema = z
  .object({
    approved_by: z.string().trim().min(1).max(200).optional(),
  })
  .default({});

// ── Backtest inputs ─────────────────────────────────────────────────────────
// Mirrors src/lib/rulepack/types.ts. A firm supplies its own trade/equity
// history to replay — there is no live-provider-to-EvaluationInput adapter
// yet, so this is the shape a history export or a future ingestion job must
// produce.

const accountContextSchema = z.object({
  id: z.string().min(1),
  login: z.string().min(1),
  phase: z.enum(['challenge', 'verification', 'funded']),
  startingBalance: z.number(),
  currentBalance: z.number(),
  currentEquity: z.number(),
  netTransfers: z.number().optional(),
});

const tradeInputSchema = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1),
  symbolClass: z.string().optional(),
  openTime: z.string(),
  closeTime: z.string().nullable().optional(),
  profit: z.number(),
  size: z.number(),
  isOpen: z.boolean().optional(),
});

const equitySnapshotSchema = z.object({
  at: z.string(),
  balance: z.number(),
  equity: z.number(),
});

const evaluationInputSchema = z.object({
  account: accountContextSchema,
  trades: z.array(tradeInputSchema),
  snapshots: z.array(equitySnapshotSchema).optional(),
  newsEvents: z
    .array(z.object({ at: z.string(), impact: z.enum(['red', 'orange', 'yellow']), currency: z.string() }))
    .optional(),
  now: z.string(),
});

const providerReportedBreachSchema = z.object({
  accountId: z.string().min(1),
  type: z.string().min(1),
  at: z.string(),
  amount: z.number().nullable().optional(),
});

export const runBacktestBodySchema = z.object({
  window_start: z.string(),
  window_end: z.string(),
  account_inputs: z.array(evaluationInputSchema).min(1, 'At least one account is required to run a backtest.'),
  provider_reported: z.array(providerReportedBreachSchema).default([]),
});
