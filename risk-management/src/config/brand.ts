/**
 * White-label brand configuration.
 *
 * Every deployment sets its own default brand via Vercel env vars; tenants
 * may override via settings where supported. All values have defaults so
 * the public demo keeps working unbranded.
 *
 * NEXT_PUBLIC_* vars are inlined client-side; the `email` block is read only
 * on the server (Resend/Gmail transports).
 *
 * Logo/favicon URLs should be ABSOLUTE per client (e.g. a Supabase Storage
 * public URL) because `public/` assets are shared by every deployment built
 * from this repo.
 */
export const brand = {
  /** Product name shown in the sidebar, login, emails, and browser tab. */
  productName: process.env.NEXT_PUBLIC_BRAND_NAME ?? 'PropRisk',
  /** Company line shown under the product name. */
  companyName: process.env.NEXT_PUBLIC_BRAND_COMPANY ?? 'PropRisk',
  /** Browser-tab / metadata description. */
  tagline:
    process.env.NEXT_PUBLIC_BRAND_TAGLINE ??
    'Real-time trade risk monitoring and compliance',
  /** Absolute URL preferred; falls back to the bundled logo. */
  logoUrl: process.env.NEXT_PUBLIC_BRAND_LOGO_URL ?? '/proprisk-logo.svg',
  /** Optional absolute favicon URL; empty uses the bundled app icon. */
  faviconUrl: process.env.NEXT_PUBLIC_BRAND_FAVICON_URL ?? '',
  colors: {
    /** Accent hex (buttons, highlights). Empty → stylesheet default #dc2626. */
    accent: process.env.NEXT_PUBLIC_BRAND_ACCENT ?? '',
    /** Neutral/metallic hex. Empty → stylesheet default #c0c0c0. */
    neutral: process.env.NEXT_PUBLIC_BRAND_NEUTRAL ?? '',
  },
  email: {
    /** Display name on outbound email (server-only). */
    senderName:
      process.env.BRAND_EMAIL_SENDER_NAME ??
      process.env.NEXT_PUBLIC_BRAND_NAME ??
      'Risk Management',
    /** Verified sender address (Resend domain or Gmail user). */
    fromAddress: process.env.BRAND_EMAIL_FROM ?? process.env.GMAIL_USER ?? '',
  },
} as const;

/** CSS-variable overrides for set brand colors (injected in the root layout). */
export function brandCssOverrides(): string {
  const rules: string[] = [];
  if (brand.colors.accent) rules.push(`--accent-red: ${brand.colors.accent};`);
  if (brand.colors.neutral) rules.push(`--silver: ${brand.colors.neutral};`);
  return rules.length > 0 ? `:root{${rules.join('')}}` : '';
}
