import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { DEMO_MODE } from '@/lib/demo';

/**
 * The root splits by who is asking.
 *
 * Before this was a self-serve product, `/` redirected straight to `/risk` and
 * middleware bounced anyone signed-out to `/login` — which meant a prospective
 * customer typing the domain hit a login wall and never saw what they were
 * being asked to buy. Signed-out traffic now lands on the marketing page.
 *
 * A demo deployment is a sales demo: send it to the operator view, which is the
 * thing being demonstrated.
 */
export default async function Root() {
  if (DEMO_MODE) redirect('/risk');

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  redirect(data.user ? '/risk' : '/home');
}
