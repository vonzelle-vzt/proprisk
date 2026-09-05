import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Deny-by-default: every matched route requires an authenticated session
// unless explicitly listed in the allowlist, so new routes are protected
// automatically. The list lives in src/lib/auth/public-routes.ts so its
// prefix-matching rule can be tested directly.
import { isPublicApi, isPublicPage } from '@/lib/auth/public-routes';

// Same-origin requests don't need CORS headers. Only emit them for the
// configured app origin — an unset env var must never widen access to '*'.
function corsHeaders(): Record<string, string> {
  const origin = process.env.NEXT_PUBLIC_APP_URL;
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function applyCors(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(corsHeaders())) {
    response.headers.set(key, value);
  }
  return response;
}


export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith('/api/');

  // Cron routes are machine-only: require the shared secret even in demo
  // mode. Route handlers keep their own CRON_SECRET checks as a second layer.
  if (pathname.startsWith('/api/cron/')) {
    const secret = process.env.CRON_SECRET;
    const authHeader = request.headers.get('authorization');
    if (!secret || authHeader !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.next();
  }

  // Platform-operator routes act ACROSS tenants (approving a firm's rule pack
  // for enforcement), so no tenant session can authorise them — the caller is
  // us, not a customer. Gated on a separate shared secret, checked before the
  // demo-mode bypass below so a demo deployment can never expose them.
  if (pathname.startsWith('/api/platform-admin/')) {
    const secret = process.env.PLATFORM_ADMIN_SECRET;
    const authHeader = request.headers.get('authorization');
    if (!secret || authHeader !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.next();
  }

  // Demo mode: fully public, mock-data sales demo. Bypass auth before
  // touching Supabase (the DB is locked). Writes are blocked structurally:
  // the admin client factory and the platform facade both throw in demo mode.
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') {
    const res = NextResponse.next();
    return isApi ? applyCors(res) : res;
  }

  // CORS preflight for API routes
  if (request.method === 'OPTIONS' && isApi) {
    const headers = corsHeaders();
    if (Object.keys(headers).length > 0) {
      headers['Access-Control-Max-Age'] = '86400';
    }
    return new NextResponse(null, { status: 204, headers });
  }

  if (isApi && isPublicApi(pathname)) {
    return applyCors(NextResponse.next());
  }

  const response = NextResponse.next();
  if (isApi) applyCors(response);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]
        ) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  const { data } = await supabase.auth.getUser();
  const isLoggedIn = Boolean(data.user);

  if (!isLoggedIn && isApi) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isLoggedIn && !isPublicPage(pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/login';
    redirectUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (isLoggedIn && pathname === '/login') {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/deductions';
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  matcher: [
    // All API routes
    '/api/:path*',
    // All pages except Next internals and static assets (anything with a dot)
    '/((?!_next|favicon.ico|.*\\..*).*)',
  ],
};
