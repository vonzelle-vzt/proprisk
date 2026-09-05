'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { createClient } from '@/lib/supabase/client';
import { brand } from '@/config/brand';

export default function SignupPage() {
  const router = useRouter();
  const [firmName, setFirmName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const res = await fetch('/api/tenancy/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firmName, ownerEmail, ownerPassword }),
    });
    const payload = await res.json().catch(() => ({}));

    if (!res.ok) {
      setError(payload.error ?? 'Signup failed');
      setLoading(false);
      return;
    }

    // The account exists server-side with the owner's password already
    // hashed and discarded by us; sign in client-side the same way login
    // does, so this page never itself holds a session token.
    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: ownerEmail,
      password: ownerPassword,
    });

    if (signInError) {
      setError(signInError.message);
      setLoading(false);
      return;
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
          <p className="text-sm text-gray-500 mt-1">Create your firm&apos;s account</p>
        </div>

        <form onSubmit={handleSignup} className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-8 shadow-2xl">
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Firm name</label>
              <input
                type="text"
                value={firmName}
                onChange={(e) => setFirmName(e.target.value)}
                placeholder="Acme Prop Trading"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/30 transition-all"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Your email</label>
              <input
                type="email"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                placeholder="owner@acmeprop.com"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/30 transition-all"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Password</label>
              <input
                type="password"
                value={ownerPassword}
                onChange={(e) => setOwnerPassword(e.target.value)}
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
            disabled={loading}
            className="mt-6 w-full bg-red-600 hover:bg-red-700 text-white font-medium py-2.5 rounded-xl transition-all shadow-lg shadow-red-500/20 hover:shadow-red-500/40 disabled:opacity-50"
          >
            {loading ? 'Creating account...' : 'Create account'}
          </button>
          <p className="mt-4 text-center text-xs text-gray-500">
            Already have an account?{' '}
            <a href="/login" className="text-gray-300 hover:text-white">
              Sign in
            </a>
          </p>
        </form>
      </div>
    </div>
  );
}
