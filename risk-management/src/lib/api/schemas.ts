import { z } from 'zod';

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(1000).default(50),
});

export const dateRangeQuerySchema = z.object({
  start_date: z.string().date().optional(),
  end_date: z.string().date().optional(),
});

export const accountListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().min(1).max(100).optional(),
  phase: z.enum(['challenge', 'verification', 'funded']).optional(),
  challenge_type: z.enum(['pro', 'flex', '1_phase']).optional(),
  account_size: z.coerce
    .number()
    .int()
    .refine((v) => [2500, 5000, 10000, 25000, 50000, 100000, 200000, 300000].includes(v), {
      message: 'Unsupported account size',
    })
    .optional(),
});

export const violationsListQuerySchema = paginationQuerySchema
  .merge(dateRangeQuerySchema)
  .extend({
    violation_type: z
      .enum(['overleveraging', 'hft', 'martingale', 'news', 'grid', 'copy'])
      .optional(),
    status: z
      .enum(['detected', 'confirmed', 'deducted', 'dismissed', 'under_review'])
      .optional(),
    account_login: z.string().trim().min(1).max(100).optional(),
  });

export const deductionsListQuerySchema = paginationQuerySchema
  .merge(dateRangeQuerySchema)
  .extend({
    violation_type: z
      .enum(['overleveraging', 'hft', 'martingale', 'news', 'grid', 'copy'])
      .optional(),
  });

export const emailsListQuerySchema = paginationQuerySchema.extend({
  account_id: z.string().uuid().optional(),
  template_type: z.string().optional(),
  search: z.string().trim().max(200).optional(),
  status: z.enum(['sent', 'failed', 'pending']).optional(),
});

export const summaryQuerySchema = dateRangeQuerySchema;

export const accountLoginParamSchema = z.object({
  login: z.string().trim().min(1).max(50),
});

export const violationIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const executeDeductionBodySchema = z.object({
  account_id: z.string().uuid(),
  violation_id: z.string().uuid().optional(),
  amount: z.coerce.number().positive(),
  reason: z.string().trim().min(3).max(1000),
});

export const sendEmailBodySchema = z.object({
  account_id: z.string().uuid(),
  recipient: z.string().email(),
  subject: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1),
  violation_id: z.string().uuid().optional(),
  deduction_id: z.string().uuid().optional(),
});

const riskRuleTypeSchema = z.enum([
  'max_daily_loss',
  'max_position_risk_pct',
  'max_consecutive_losses',
  'instrument_blocklist',
]);

export const riskRuleInputSchema = z.object({
  id: z.string().uuid().optional(),
  type: riskRuleTypeSchema,
  enabled: z.boolean().default(true),
  threshold: z.coerce.number().positive().nullable().optional(),
  warning_threshold: z.coerce.number().positive().nullable().optional(),
  instrument_list: z.array(z.string().trim().min(1)).nullable().optional(),
});

export const createRiskProfileBodySchema = z.object({
  account_id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  rules: z.array(riskRuleInputSchema).min(1),
});

export const preTradeEvaluateBodySchema = z.object({
  account_id: z.string().uuid(),
  symbol: z.string().trim().min(1).max(30),
  direction: z.enum(['buy', 'sell']),
  entry_price: z.coerce.number().positive(),
  stop_loss_price: z.coerce.number().positive(),
  quantity: z.coerce.number().positive(),
  account_balance: z.coerce.number().positive(),
  open_exposure_value: z.coerce.number().min(0),
  daily_realized_pnl: z.coerce.number(),
  consecutive_losses: z.coerce.number().int().min(0),
});

export const riskEventBodySchema = z.object({
  account_id: z.string().uuid(),
  event_type: z.string().trim().min(1).max(120),
  symbol: z.string().trim().min(1).max(30).optional(),
  pnl_delta: z.coerce.number().optional(),
  exposure_value: z.coerce.number().min(0).optional(),
  quantity: z.coerce.number().positive().optional(),
  price: z.coerce.number().positive().optional(),
  occurred_at: z.string().datetime().optional(),
  idempotency_key: z.string().trim().min(8).max(200),
  metadata: z.record(z.unknown()).optional(),
});

export const riskAlertListQuerySchema = paginationQuerySchema.extend({
  account_id: z.string().uuid().optional(),
  status: z.enum(['new', 'acknowledged', 'resolved']).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
});

export const sessionReportQuerySchema = z.object({
  account_id: z.string().uuid(),
  session_date: z.string().date(),
});

export const generateSessionReportBodySchema = z.object({
  account_id: z.string().uuid(),
  session_date: z.string().date().optional(),
});

export const payoutsListQuerySchema = paginationQuerySchema
  .merge(dateRangeQuerySchema)
  .extend({
    status: z.enum(['Pending', 'Investigate', 'Cleared', 'Rejected', 'Banned']).optional(),
    search: z.string().trim().min(1).max(100).optional(),
  });

export const updatePayoutBodySchema = z.object({
  status: z.enum(['Pending', 'Investigate', 'Cleared', 'Rejected', 'Banned']).optional(),
  notes: z.string().max(5000).optional(),
});

export const ipCheckBodySchema = z.object({
  ips: z.array(z.string().trim().min(7).max(45)).min(1).max(50),
  kycCountry: z.string().optional(),
});

export const historyListQuerySchema = paginationQuerySchema
  .merge(dateRangeQuerySchema)
  .extend({
    decision: z.enum(['approved', 'rejected']).optional(),
    search: z.string().trim().min(1).max(100).optional(),
  });

export function validationErrorResponse(error: z.ZodError) {
  return Response.json(
    { error: 'Validation failed', details: error.issues.map((i) => ({ path: i.path, message: i.message })) },
    { status: 400 }
  );
}
