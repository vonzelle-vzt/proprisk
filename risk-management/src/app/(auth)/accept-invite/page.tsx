'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { createClient } from '@/lib/supabase/client';
import { brand } from '@/config/brand';

export default function AcceptInvitePage() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Read the token from the URL on the client rather than via
  // useSearchParams(), matching the pattern already used in
  // src/app/(auth)/login/page.tsx — avoids requiring a Suspense boundary for
  // what is a one-time read on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setToken(new URLSearchParams(window.location.search).get('token') ?? '');
  }, []);

  const handleAccept = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    if (!token) {
      setError('Missing or invalid invite link');
      setLoading(false);
      return;
    }

    const res = await fetch('/api/tenancy/invites/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    });
    const payload = await res.json().catch(() => ({}));

    if (!res.ok) {
      setError(payload.error ?? 'Failed to accept invite');
      setLoading(false);
      return;
    }

    // The account now exists with app_metadata already set by the redemption
    // route; sign in the same way login/signup do.
    const supabase = createClient();
    const email = payload.email as string | undefined;
    if (email) {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError(signInError.message);
        setLoading(false);
        return;
      }
    }

    router.push('/deductions');
    router.refresh();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <Image src={brand.logoUrl} alt={brand.companyName} width={56} height={56} className="rounded-2xl shadow-lg" />
          </div>
          <h1 className="text-2xl font-bold text-white">{brand.productName}</h1>
          <p className="text-sm text-gray-500 mt-1">Accept your invite</p>
        </div>

        <form onSubmit={handleAccept} className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-8 shadow-2xl">
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Set a password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                minLength={8}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/30 transition-all"
                required
              />
            </div>
          </div>
          {error ? (
            <p className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={loading || !token}
            className="mt-6 w-full bg-red-600 hover:bg-red-700 text-white font-medium py-2.5 rounded-xl transition-all shadow-lg shadow-red-500/20 hover:shadow-red-500/40 disabled:opacity-50"
          >
            {loading ? 'Joining...' : 'Join'}
          </button>
        </form>
      </div>
    </div>
  );
}
