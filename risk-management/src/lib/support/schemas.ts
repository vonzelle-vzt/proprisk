import { z } from 'zod';

export const createTicketBodySchema = z.object({
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(5000),
  severity: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
});
