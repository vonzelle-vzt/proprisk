import { describe, expect, it } from 'vitest';
import { PUBLIC_API_PREFIXES, PUBLIC_PAGES, isPublicApi, isPublicPage } from './public-routes';

/**
 * This allowlist is the deny-by-default boundary for the entire product, and it
 * is matched by PREFIX — so adding an entry is exactly the kind of change that
 * looks harmless and opens everything. Adding '/' in particular reads like a
 * wildcard. It is not, and that is asserted here rather than argued in review.
 */

describe('page allowlist', () => {
  it.each(PUBLIC_PAGES)('treats the listed page %s as public', (path) => {
    expect(isPublicPage(path)).toBe(true);
  });

  // The load-bearing assertion: '/' must not behave as a prefix wildcard.
  it.each([
    '/risk',
    '/payouts',
    '/violations',
    '/deductions',
    '/settings',
    '/connections',
    '/enforcement',
    '/reviewer',
    '/email-log',
    '/network',
    '/evidence/abc-123',
    '/violations/account/1001',
  ])('still requires a session for %s', (path) => {
    expect(isPublicPage(path)).toBe(false);
  });

  // A prefix list will happily match a longer word that merely starts the same.
  it.each(['/loginsomething', '/homework', '/pricingsecrets', '/signupadmin', '/accounts', '/alerts'])(
    'does not leak a public prefix into the sibling route %s',
    (path) => {
      expect(isPublicPage(path)).toBe(false);
    }
  );

  it('keeps sub-paths of a genuinely public page public', () => {
    expect(isPublicPage('/accept-invite/token-abc')).toBe(true);
  });

  // The trader-facing page: public because the token in the path is its own
  // authentication (src/lib/trader/tokens.ts), never a bare '/a' with no token.
  it('treats a trader link as public', () => {
    expect(isPublicPage('/a/deadbeef1234')).toBe(true);
  });
});

describe('api allowlist', () => {
  it.each(PUBLIC_API_PREFIXES)('treats %s as public', (path) => {
    expect(isPublicApi(path)).toBe(true);
  });

  // Every one of these reads or writes tenant data.
  it.each([
    '/api/accounts',
    '/api/payouts',
    '/api/violations',
    '/api/deductions',
    '/api/risk/dashboard',
    '/api/connections',
    '/api/support/tickets',
    '/api/tenancy/invites',
    '/api/billing/checkout',
  ])('still requires a session for %s', (path) => {
    expect(isPublicApi(path)).toBe(false);
  });

  // Signup is public but the rest of /api/tenancy is not; a careless entry of
  // '/api/tenancy' would expose invite management to anonymous callers.
  it('does not make the whole tenancy surface public', () => {
    expect(isPublicApi('/api/tenancy/invites')).toBe(false);
    expect(isPublicApi('/api/tenancy/signup')).toBe(true);
  });

  // Likewise billing: only the Stripe webhook is public, and only because a
  // verified signature is its authentication.
  it('exposes only the Stripe webhook from the billing surface', () => {
    expect(isPublicApi('/api/billing/webhook')).toBe(true);
    expect(isPublicApi('/api/billing/portal')).toBe(false);
  });

  // The firm-side link management route (POST/GET/DELETE trader-link) must
  // stay behind a session — only the trader-facing read route is public.
  it('does not expose trader-link management to anonymous callers', () => {
    expect(isPublicApi('/api/accounts/1001/trader-link')).toBe(false);
    expect(isPublicApi('/api/trader/deadbeef1234')).toBe(true);
  });

  // The per-violation decision record exists on BOTH sides of the boundary:
  // the trader reaches theirs through their token (public, because the token
  // is the authentication), the operator reaches any of the firm's through a
  // session. The prefix list must keep those apart — '/api/violations' is a
  // sibling of nothing public, and must never inherit the trader exemption.
  it('exposes the trader-scoped violation report but not the operator one', () => {
    expect(isPublicApi('/api/trader/x/violations/y/report')).toBe(true);
    expect(isPublicApi('/api/violations/y/report')).toBe(false);
    expect(isPublicApi('/api/violations/account/1001/report')).toBe(false);
  });
});
