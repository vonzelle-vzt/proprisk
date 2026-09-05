'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Shield } from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface RulePackRow {
  id: string;
  name: string;
  assetClass: 'forex' | 'futures';
  version: number;
  status: 'draft' | 'testing' | 'active' | 'archived';
  createdAt: string;
}

const STATUS_BADGE: Record<RulePackRow['status'], { variant: 'silver' | 'yellow' | 'green' | 'blue'; label: string }> = {
  draft: { variant: 'silver', label: 'Draft' },
  testing: { variant: 'yellow', label: 'Testing' },
  active: { variant: 'green', label: 'Active' },
  archived: { variant: 'blue', label: 'Archived' },
};

export default function RulesPage() {
  const [packs, setPacks] = useState<RulePackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/rulepack', { cache: 'no-store' });
        const json = await res.json();
        if (cancelled) return;
        setPacks(json.data ?? []);
        setDemo(Boolean(json.demo));
      } catch {
        if (!cancelled) setPacks([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Shield className="h-5 w-5 text-red-400" />
            Rule Packs
          </h1>
          <p className="text-[11px] text-gray-500 mt-1">
            Define what counts as a breach — thresholds, actions, and which phase of an account&apos;s life each rule applies to.
          </p>
        </div>
        <Link href="/rules/new">
          <Button variant="primary" size="sm">
            <Plus className="h-4 w-4" />
            New Rule Pack
          </Button>
        </Link>
      </div>

      {demo && (
        <GlassCard padding="sm" className="border-yellow-500/30">
          <p className="text-[11px] text-yellow-400">
            Demo mode: these packs are samples built from the shipped presets; edits and activations are not persisted.
          </p>
        </GlassCard>
      )}

      {loading ? (
        <p className="text-[11px] text-gray-500">Loading…</p>
      ) : packs.length === 0 ? (
        <GlassCard padding="lg" className="text-center">
          <p className="text-sm text-gray-400 mb-3">No rule packs yet. Start from a preset that matches your rulebook.</p>
          <Link href="/rules/new">
            <Button variant="primary" size="sm">
              <Plus className="h-4 w-4" />
              New Rule Pack
            </Button>
          </Link>
        </GlassCard>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {packs.map((pack) => {
            const badge = STATUS_BADGE[pack.status];
            return (
              <Link key={pack.id} href={`/rules/${pack.id}`}>
                <GlassCard hover padding="sm">
                  <div className="flex items-center justify-between mb-1.5">
                    <h3 className="text-sm font-semibold text-white truncate">{pack.name}</h3>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-gray-500">
                    <span>{pack.assetClass}</span>
                    <span>·</span>
                    <span>v{pack.version}</span>
                  </div>
                </GlassCard>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
