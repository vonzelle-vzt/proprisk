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
] as const;

export interface EnvValidationResult {
  valid: boolean;
  missing: string[];
  optionalMissing: string[];
}

export function validateEnv(): EnvValidationResult {
  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
  const optionalMissing = OPTIONAL_VARS.filter((v) => !process.env[v]);
  return { valid: missing.length === 0, missing, optionalMissing };
}

export function getEnvReport(): Record<string, 'set' | 'missing'> {
  const report: Record<string, 'set' | 'missing'> = {};
  for (const v of REQUIRED_VARS) {
    report[v] = process.env[v] ? 'set' : 'missing';
  }
  for (const v of OPTIONAL_VARS) {
    report[v] = process.env[v] ? 'set' : 'missing';
  }
  return report;
}
