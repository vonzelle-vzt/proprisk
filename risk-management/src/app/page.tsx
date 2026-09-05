import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { DEMO_MODE } from '@/lib/demo';

/**
 * The root splits by who is asking.
 *
 * This is a self-hosted admin console for a firm's own risk team, not a
 * storefront: there is no public surface to send an anonymous visitor to, so
 * `/` bounces them to the login screen. (The root itself stays on the
 * middleware allowlist — see src/lib/auth/public-routes.ts — precisely so
 * this redirect is the thing that decides, rather than a middleware bounce
 * that would append a pointless `?next=/`.)
 *
 * A demo deployment is a sales demo: send it to the operator view, which is
 * the thing being demonstrated.
 */
export default async function Root() {
  if (DEMO_MODE) redirect('/risk');

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  redirect(data.user ? '/risk' : '/login');
}
