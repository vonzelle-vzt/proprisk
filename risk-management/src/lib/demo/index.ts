/**
 * Demo mode.
 *
 * When `NEXT_PUBLIC_DEMO_MODE === 'true'` the app runs as a fully public,
 * mock-data sales demo: auth is bypassed in middleware and every data API
 * route returns coherent mock data instead of touching a live provider
 * API or the (locked) Supabase database.
 *
 * This is intentionally a single chokepoint so the real, production code
 * paths stay completely intact for later reactivation — flip the flag off
 * and the app behaves exactly as before.
 */
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

/** Asset classes the platform monitors. */
export type AssetClass = 'forex' | 'futures';

/** Parse the `?assetClass=` query param off a request, defaulting to forex. */
export function assetClassFromRequest(req?: { url: string }): AssetClass {
  if (!req) return 'forex';
  try {
    const v = new URL(req.url).searchParams.get('assetClass');
    return v === 'futures' ? 'futures' : 'forex';
  } catch {
    return 'forex';
  }
}

export interface DemoQuery {
  assetClass: AssetClass;
  page: number;
  perPage: number;
  search: string;
  violationType: string;
}

/** Parse the common list-query params used across the data routes. */
export function demoQuery(req: { url: string }): DemoQuery {
  let sp: URLSearchParams;
  try {
    sp = new URL(req.url).searchParams;
  } catch {
    sp = new URLSearchParams();
  }
  return {
    assetClass: sp.get('assetClass') === 'futures' ? 'futures' : 'forex',
    page: Number(sp.get('page')) || 1,
    perPage: Number(sp.get('per_page')) || 20,
    search: sp.get('search') || '',
    violationType: sp.get('violation_type') || '',
  };
}
