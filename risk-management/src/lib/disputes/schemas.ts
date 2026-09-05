import { z } from 'zod';

export const openDisputeBodySchema = z.object({
  subjectType: z.enum(['breach', 'payout', 'deduction']),
  subjectId: z.string().trim().min(1).max(200),
  accountId: z.string().trim().min(1).max(200).optional(),
  raisedBy: z.string().trim().min(1).max(200),
  traderStatement: z.string().trim().min(1).max(5000),
});

export const disputesListQuerySchema = z.object({
  status: z.enum(['open', 'under_review', 'upheld', 'overturned', 'withdrawn']).optional(),
  subjectType: z.enum(['breach', 'payout', 'deduction']).optional(),
});

export const disputeTransitionBodySchema = z
  .object({
    status: z.enum(['under_review', 'upheld', 'overturned', 'withdrawn']),
    resolution: z.string().trim().min(1).max(5000).optional(),
  })
  .refine(
    (v) => v.status === 'under_review' || (v.resolution && v.resolution.length > 0),
    { message: 'resolution is required when resolving a dispute (upheld/overturned/withdrawn)', path: ['resolution'] }
  );
