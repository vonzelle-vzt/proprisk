import { createClient } from '@supabase/supabase-js';
import { DEMO_MODE } from '@/lib/demo';

export function createAdminClient() {
  // Structural demo chokepoint: a demo deployment must never be able to
  // reach a real database, even with a service key set and grants restored.
  if (DEMO_MODE) {
    throw new Error('Demo mode: database access is disabled');
  }

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        fetch: (url, options = {}) => {
          return fetch(url, { ...options, cache: 'no-store' });
        },
      },
    }
  );
}
