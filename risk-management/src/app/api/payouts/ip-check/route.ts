export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { checkIPs } from '@/lib/ip/check';
import { ipCheckBodySchema, validationErrorResponse } from '@/lib/api/schemas';
import { logError } from '@/lib/logging/logger';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { DEMO_MODE } from '@/lib/demo';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const parsed = ipCheckBodySchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  if (DEMO_MODE) {
    const results = parsed.data.ips.map((ipAddr) => ({
      ip: ipAddr,
      city: 'London',
      region: 'England',
      country: parsed.data.kycCountry || 'United Kingdom',
      isp: 'Demo ISP',
      isProxy: false,
      isVpn: false,
      isTor: false,
      isDatacenter: false,
      source: 'ipapi' as const,
    }));
    return Response.json({ data: { results, mismatchDetected: false } });
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const rl = await checkRateLimit(`ip-check:${ip}`, { windowMs: 60_000, maxRequests: 20 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const results = await checkIPs(parsed.data.ips);

    const kycCountry = parsed.data.kycCountry;
    const mismatchDetected = kycCountry
      ? results.some((r) => r.country.toLowerCase() !== kycCountry.toLowerCase())
      : results.length > 1 && results.some((r) => r.country !== results[0].country);

    return Response.json({
      data: {
        results,
        mismatchDetected,
      },
    });
  } catch (err) {
    logError('IP check failed', err, { route: '/api/payouts/ip-check', category: 'external_api' });
    return Response.json({ error: 'IP check failed' }, { status: 500 });
  }
}
