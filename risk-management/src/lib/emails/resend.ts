import { brand } from '@/config/brand';

/**
 * Resend transport (primary outbound email path).
 *
 * Uses the REST API directly — no SDK dependency. Requires:
 * - RESEND_API_KEY
 * - BRAND_EMAIL_FROM: an address on a domain verified in Resend (DKIM) for
 *   this client's deployment. The display name comes from the brand config.
 */
export async function sendViaResend(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');
  if (!brand.email.fromAddress) {
    throw new Error('BRAND_EMAIL_FROM is not set (verified Resend sender address)');
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${brand.email.senderName} <${brand.email.fromAddress}>`,
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API ${res.status}: ${body}`);
  }
}
