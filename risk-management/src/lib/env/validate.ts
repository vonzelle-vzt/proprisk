import { BILLING_ENABLED } from '@/lib/billing/config';

const REQUIRED_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CRON_SECRET',
  // CORS headers are only emitted for this origin; unset means no CORS.
  'NEXT_PUBLIC_APP_URL',
] as const;

const OPTIONAL_VARS = [
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  // Outbound email: Resend is the standard path; Gmail is the legacy fallback
  'RESEND_API_KEY',
  'BRAND_EMAIL_FROM',
  'BRAND_EMAIL_SENDER_NAME',
  'GMAIL_USER',
  'GMAIL_APP_PASSWORD',
  // White-label branding (defaults keep the demo working unbranded)
  'NEXT_PUBLIC_BRAND_NAME',
  'NEXT_PUBLIC_BRAND_COMPANY',
  'NEXT_PUBLIC_BRAND_TAGLINE',
  'NEXT_PUBLIC_BRAND_LOGO_URL',
  'NEXT_PUBLIC_BRAND_FAVICON_URL',
  'NEXT_PUBLIC_BRAND_ACCENT',
  'NEXT_PUBLIC_BRAND_NEUTRAL',
  'TRADING_API_URL',
  'TRADING_API_KEY',
  'REVIEWER_AGENT_ENABLED',
  // Support ticket mailbox (src/lib/support/tickets.ts). Optional here because
  // demo mode falls back to a placeholder address; outside demo mode the
  // support module itself throws if this is unset.
  'SUPPORT_INBOX_EMAIL',
  // Stripe billing is opt-in and off by default — this is a self-hosted
  // console, not a storefront (src/lib/billing/config.ts). Unset is a valid,
  // supported deployment, so the flag itself is never required.
  'BILLING_ENABLED',
] as const;

// Only meaningful when BILLING_ENABLED=true, and then these two ARE billing:
// without the secret key nothing can create a checkout or portal session, and
// without the signing secret the webhook has no authentication and rejects
// every event. A deployment that opts into billing without them is broken in
// a way worth reporting at cold start rather than at the first invoice.
const BILLING_REQUIRED_VARS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] as const;

// Per-tier Stripe Price ids. Optional even with billing on: a deployment may
// sell only some tiers, and checkout already answers 501 naming the exact
// missing env var for a tier it has no price for (src/lib/billing/checkout.ts).
const BILLING_OPTIONAL_VARS = [
  'STRIPE_PRICE_STARTER',
  'STRIPE_PRICE_GROWTH',
  'STRIPE_PRICE_SCALE',
] as const;

/**
 * With billing off, the Stripe vars are not "missing" — they are irrelevant,
 * and reporting them as optional-missing on every self-hosted deployment
 * would train operators to ignore the report. They enter the lists only when
 * the flag turns billing on.
 */
function requiredVars(): readonly string[] {
  return BILLING_ENABLED ? [...REQUIRED_VARS, ...BILLING_REQUIRED_VARS] : REQUIRED_VARS;
}

function optionalVars(): readonly string[] {
  return BILLING_ENABLED ? [...OPTIONAL_VARS, ...BILLING_OPTIONAL_VARS] : OPTIONAL_VARS;
}

export interface EnvValidationResult {
  valid: boolean;
  missing: string[];
  optionalMissing: string[];
}

export function validateEnv(): EnvValidationResult {
  const missing = requiredVars().filter((v) => !process.env[v]);
  const optionalMissing = optionalVars().filter((v) => !process.env[v]);
  return { valid: missing.length === 0, missing, optionalMissing };
}

export function getEnvReport(): Record<string, 'set' | 'missing'> {
  const report: Record<string, 'set' | 'missing'> = {};
  for (const v of requiredVars()) {
    report[v] = process.env[v] ? 'set' : 'missing';
  }
  for (const v of optionalVars()) {
    report[v] = process.env[v] ? 'set' : 'missing';
  }
  return report;
}
