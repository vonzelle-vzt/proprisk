/**
 * The public-route allowlist for the deny-by-default middleware.
 *
 * Extracted from middleware.ts so it can be tested directly. The matching rule
 * is prefix-based, which makes adding an entry deceptively risky — '/' in a
 * prefix list looks like it would make the entire application public. It does
 * not, for the reason spelled out below, but "it does not" is a claim that
 * belongs in a test rather than in a reviewer's head.
 *
 * Keep this module free of Node built-ins: middleware runs on the edge runtime.
 */

export const PUBLIC_API_PREFIXES = [
  '/api/health',
  '/api/tenancy/signup',
  '/api/tenancy/invites/accept',
  // Stripe cannot present a session cookie; the signature verified inside the
  // route handler is the only authentication this route has.
  '/api/billing/webhook',
  // Traders are not tenant members and have no Supabase session (see
  // middleware.ts) — the token in the URL is their entire authentication,
  // verified server-side on every request by src/lib/trader/tokens.ts.
  '/api/trader/',
];

/**
 * '/' matches the ROOT ONLY. `isPublicPage` tests
 * `pathname === page || pathname.startsWith(page + '/')`, and for '/' the
 * second arm becomes `startsWith('//')`, which no ordinary path satisfies.
 *
 * The root must be public so that src/app/page.tsx is the code that decides
 * where a visitor goes (signed out -> /login, signed in -> /risk), rather
 * than middleware bouncing '/' with a pointless `?next=/`. It renders nothing
 * itself, so making it public exposes no data.
 *
 * There is deliberately no marketing surface here: this is a self-hosted
 * console for a firm's own risk team, so the old landing and pricing routes
 * were deleted and must not be re-added to this list. public-routes.test.ts
 * asserts they are no longer public.
 */
// '/a' is the trader-facing account view (src/app/(trader)/a/[token]) — the
// token in the path is the whole authentication check, verified server-side
// on every request. It carries no session and reaches no other route.
export const PUBLIC_PAGES = ['/', '/login', '/signup', '/accept-invite', '/a'];

export function isPublicApi(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function isPublicPage(pathname: string): boolean {
  return PUBLIC_PAGES.some((page) => pathname === page || pathname.startsWith(`${page}/`));
}
