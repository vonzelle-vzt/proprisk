import { z } from 'zod';
import { INVITABLE_ROLES } from './invites';

// Local to src/lib/tenancy — src/lib/api/schemas.ts is an existing shared
// file outside this feature's scope, so tenancy routes get their own schema
// module rather than growing an out-of-scope file.

export const signupBodySchema = z.object({
  firmName: z.string().trim().min(2).max(200),
  ownerEmail: z.string().trim().email(),
  ownerPassword: z.string().min(8).max(200),
});

export const createInviteBodySchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(INVITABLE_ROLES),
});

export const acceptInviteBodySchema = z.object({
  token: z.string().trim().min(32).max(512),
  password: z.string().min(8).max(200),
});
