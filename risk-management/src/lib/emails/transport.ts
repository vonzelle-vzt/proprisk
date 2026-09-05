import { sendViaResend } from './resend';
import { sendEmail as sendViaGmail } from './gmail';

/**
 * Outbound email transport selector: Resend when RESEND_API_KEY is set
 * (the standard per-client setup), otherwise the legacy Gmail/nodemailer
 * path when GMAIL_USER is configured. Fails loudly when neither is.
 */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  if (process.env.RESEND_API_KEY) {
    return sendViaResend(opts);
  }
  if (process.env.GMAIL_USER) {
    return sendViaGmail(opts);
  }
  throw new Error('No email transport configured: set RESEND_API_KEY (+ BRAND_EMAIL_FROM) or GMAIL_USER');
}
