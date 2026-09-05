import { NextRequest, NextResponse } from 'next/server';
import { getStripeClient } from '@/lib/billing/stripe-client';
import { processStripeEvent } from '@/lib/billing/webhook-handler';
import { BILLING_ENABLED, BILLING_DISABLED_MESSAGE } from '@/lib/billing/config';

export const dynamic = 'force-dynamic';

/**
 * POST /api/billing/webhook — Stripe → us.
 *
 * Public (listed in PUBLIC_API_PREFIXES in middleware.ts): Stripe cannot
 * present a session cookie, so this route has no other authentication layer.
 * The Stripe signature IS the authentication. Treat a request that fails
 * `constructEvent` exactly like an unauthenticated write attempt — reject it
 * before any event data is trusted or acted on, never fall back to parsing
 * the body as JSON "just to see what it says."
 *
 * The raw, unparsed request body is required for signature verification —
 * `request.text()`, never `request.json()` first. Stripe signs the exact
 * bytes it sent; re-serializing a parsed-and-reparsed body would not
 * reproduce them and every signature check would fail.
 *
 * When BILLING_ENABLED is false this route 404s before reading the request
 * at all. That is not just tidiness: with Stripe unconfigured there is no
 * signing secret, so no request reaching here could ever be a genuine
 * signature-verified Stripe event — the only callers are unauthenticated
 * ones, and the public allowlist entry for this path (see
 * src/lib/auth/public-routes.ts) means middleware will not turn them away.
 */
export async function POST(request: NextRequest) {
  if (!BILLING_ENABLED) {
    return NextResponse.json({ error: BILLING_DISABLED_MESSAGE }, { status: 404 });
  }

  const signature = request.headers.get('stripe-signature');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rawBody = await request.text();

  let event;
  try {
    event = getStripeClient().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    // Signature mismatch, expired timestamp, or malformed payload — all
    // treated identically: reject, do not attempt to salvage the payload.
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  try {
    await processStripeEvent(event);
  } catch {
    // A 500 tells Stripe to retry the event later (Stripe retries with
    // backoff on non-2xx). Swallowing this instead would silently drop a
    // billing update — e.g. a plan change that would matter to entitlements.
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
