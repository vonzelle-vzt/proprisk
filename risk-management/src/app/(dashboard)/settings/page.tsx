'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { GlassCard } from '@/components/ui/glass-card';
import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/client';
import { DEMO_MODE } from '@/lib/demo';
import { RiskRulesSettings } from '@/components/settings/risk-rules';
import { User, Mail, Lock, LogOut, Shield } from 'lucide-react';

export default function SettingsPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<{ email: string; id: string; created_at: string } | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (DEMO_MODE) {
      setUser({ email: 'demo@riskplatform.app', id: 'demo-user', created_at: new Date().toISOString() });
      return;
    }
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        setUser({
          email: data.user.email || '',
          id: data.user.id,
          created_at: data.user.created_at,
        });
      }
    });
  }, [supabase]);

  const handlePasswordChange = async () => {
    setPasswordMsg(null);
    if (!newPassword || !confirmPassword) {
      setPasswordMsg({ type: 'error', text: 'Please fill in all password fields.' });
      return;
    }
    if (newPassword.length < 8) {
      setPasswordMsg({ type: 'error', text: 'Password must be at least 8 characters.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMsg({ type: 'error', text: 'Passwords do not match.' });
      return;
    }
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSaving(false);
    if (error) {
      setPasswordMsg({ type: 'error', text: 'Failed to update password. Please try again.' });
    } else {
      setPasswordMsg({ type: 'success', text: 'Password updated successfully.' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push('/login');
  };

  return (
    <div className="space-y-5 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold bg-gradient-to-r from-red-400 to-orange-400 bg-clip-text text-transparent">
          Settings
        </h1>
        <p className="mt-1 text-xs text-gray-500">
          Manage your account, risk rules, and preferences.
        </p>
      </div>

      {/* Per-asset-class risk rules */}
      <RiskRulesSettings />

      {/* Account Info */}
      <GlassCard>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-xl bg-white/5">
            <User className="h-5 w-5 text-gray-400" />
          </div>
          <h2 className="text-sm font-semibold text-white">Account</h2>
        </div>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Mail className="h-4 w-4 text-gray-500" />
            <div>
              <span className="block text-[10px] text-gray-500 uppercase tracking-wider">Email</span>
              <span className="text-sm text-white">{user?.email || '—'}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Shield className="h-4 w-4 text-gray-500" />
            <div>
              <span className="block text-[10px] text-gray-500 uppercase tracking-wider">User ID</span>
              <span className="text-sm text-gray-400 font-mono text-[11px]">{user?.id || '—'}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <User className="h-4 w-4 text-gray-500" />
            <div>
              <span className="block text-[10px] text-gray-500 uppercase tracking-wider">Member Since</span>
              <span className="text-sm text-gray-400">{user?.created_at ? new Date(user.created_at).toLocaleDateString() : '—'}</span>
            </div>
          </div>
        </div>
      </GlassCard>

      {/* Change Password */}
      <GlassCard>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-xl bg-white/5">
            <Lock className="h-5 w-5 text-gray-400" />
          </div>
          <h2 className="text-sm font-semibold text-white">Change Password</h2>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">New Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500/50"
              placeholder="Enter new password"
            />
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">Confirm Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500/50"
              placeholder="Confirm new password"
            />
          </div>
          {passwordMsg && (
            <p className={`text-xs ${passwordMsg.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
              {passwordMsg.text}
            </p>
          )}
          <Button variant="primary" size="sm" onClick={handlePasswordChange} disabled={saving}>
            {saving ? 'Updating...' : 'Update Password'}
          </Button>
        </div>
      </GlassCard>

      {/* Sign Out */}
      <GlassCard>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-red-500/10">
              <LogOut className="h-5 w-5 text-red-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Sign Out</h2>
              <p className="text-[11px] text-gray-500">End your current session</p>
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={handleSignOut}>
            Sign Out
          </Button>
        </div>
      </GlassCard>
    </div>
  );
}
