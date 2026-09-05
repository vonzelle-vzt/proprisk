'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, PlayCircle, Rocket, Save, TestTube2 } from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs } from '@/components/ui/tabs';
import { RuleForm } from '@/components/rulepack/rule-form';
import { DiffView } from '@/components/rulepack/diff-view';
import { ReconciliationView } from '@/components/rulepack/reconciliation-view';
import { ImpactView } from '@/components/rulepack/impact-view';
import type { RulePack } from '@/lib/rulepack/schema';

interface StoredPack {
  id: string;
  tenantId: string;
  name: string;
  assetClass: 'forex' | 'futures';
  version: number;
  status: 'draft' | 'testing' | 'active' | 'archived';
  pack: RulePack;
  approvedAt: string | null;
}

const STATUS_BADGE: Record<StoredPack['status'], { variant: 'silver' | 'yellow' | 'green' | 'blue'; label: string }> = {
  draft: { variant: 'silver', label: 'Draft' },
  testing: { variant: 'yellow', label: 'Testing' },
  active: { variant: 'green', label: 'Active' },
  archived: { variant: 'blue', label: 'Archived' },
};

export default function RulePackDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [pack, setPack] = useState<StoredPack | null>(null);
  const [draftPack, setDraftPack] = useState<RulePack | null>(null);
  const [diff, setDiff] = useState<{ changes: Array<{ ruleId: string; kind: 'added' | 'removed' | 'changed'; summary: string }>; identical: boolean } | null>(null);
  const [diffAgainst, setDiffAgainst] = useState<string | undefined>();
  const [tab, setTab] = useState('rules');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  const [backtestHistory, setBacktestHistory] = useState<Array<Record<string, unknown>>>([]);
  const [latestBacktest, setLatestBacktest] = useState<Record<string, unknown> | null>(null);
  const [backtestInputJson, setBacktestInputJson] = useState('[]');
  const [providerReportedJson, setProviderReportedJson] = useState('[]');

  const [impact, setImpact] = useState<Record<string, unknown> | null>(null);
  const [impactNote, setImpactNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [packRes, diffRes] = await Promise.all([
        fetch(`/api/rulepack/${id}`, { cache: 'no-store' }),
        fetch(`/api/rulepack/${id}/diff`, { cache: 'no-store' }),
      ]);
      const packJson = await packRes.json();
      if (packRes.ok) {
        setPack(packJson.data);
        setDraftPack(packJson.data.pack);
      }
      const diffJson = await diffRes.json();
      if (diffRes.ok && diffJson.data) {
        setDiff(diffJson.data);
        setDiffAgainst(diffJson.before?.name ? `${diffJson.before.name} (v${diffJson.before.version})` : undefined);
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const saveDraft = async () => {
    if (!draftPack) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/rulepack/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pack: draftPack }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage({ kind: 'error', text: json.error ?? 'Failed to save.' });
        return;
      }
      setMessage({ kind: 'info', text: 'Draft saved.' });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const promote = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/rulepack/${id}/promote`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        setMessage({ kind: 'error', text: json.error ?? 'Failed to promote.' });
        return;
      }
      setMessage({ kind: 'info', text: json.message ?? 'Moved to testing.' });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const runBacktest = async () => {
    setBusy(true);
    setMessage(null);
    try {
      let accountInputs: unknown;
      let providerReported: unknown;
      try {
        accountInputs = JSON.parse(backtestInputJson);
        providerReported = JSON.parse(providerReportedJson);
      } catch {
        setMessage({ kind: 'error', text: 'Account inputs / provider-reported breaches must be valid JSON.' });
        return;
      }

      const now = new Date();
      const windowStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const res = await fetch(`/api/rulepack/${id}/backtest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          window_start: windowStart,
          window_end: now.toISOString(),
          account_inputs: accountInputs,
          provider_reported: providerReported,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage({ kind: 'error', text: json.error ?? 'Backtest failed.' });
        return;
      }
      if (json.demo) {
        setMessage({ kind: 'info', text: 'Demo mode: backtest computed but not persisted.' });
        if (json.data) setLatestBacktest(json.data);
        return;
      }
      setLatestBacktest(json.data);
      await loadBacktestHistory();
    } finally {
      setBusy(false);
    }
  };

  const loadBacktestHistory = useCallback(async () => {
    const res = await fetch(`/api/rulepack/${id}/backtest`, { cache: 'no-store' });
    const json = await res.json();
    if (res.ok) setBacktestHistory(json.data ?? []);
  }, [id]);

  const loadImpact = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/rulepack/${id}/impact`, { cache: 'no-store' });
      const json = await res.json();
      if (res.ok) {
        setImpact(json.data);
        setImpactNote(json.note ?? null);
      } else {
        setMessage({ kind: 'error', text: json.error ?? 'Failed to load impact preview.' });
      }
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/rulepack/${id}/activate`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        // ActivationBlockedError messages are written for the customer — show verbatim.
        setMessage({ kind: 'error', text: json.error ?? 'Activation blocked.' });
        return;
      }
      setMessage({ kind: 'info', text: json.message ?? 'Activated.' });
      await load();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (tab === 'backtest') loadBacktestHistory();
  }, [tab, loadBacktestHistory]);

  if (loading) {
    return <div className="p-6"><p className="text-[11px] text-gray-500">Loading…</p></div>;
  }

  if (!pack || !draftPack) {
    return (
      <div className="p-6">
        <p className="text-sm text-gray-400">Rule pack not found.</p>
      </div>
    );
  }

  const badge = STATUS_BADGE[pack.status];

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <button onClick={() => router.push('/rules')} className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-300 mb-2">
            <ArrowLeft className="h-3 w-3" />
            All rule packs
          </button>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-white">{pack.name}</h1>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </div>
          <p className="text-[11px] text-gray-500 mt-1">
            {pack.assetClass} · v{pack.version}
          </p>
        </div>
        <div className="flex gap-2">
          {pack.status === 'draft' && (
            <>
              <Button variant="secondary" size="sm" onClick={saveDraft} loading={busy}>
                <Save className="h-4 w-4" />
                Save draft
              </Button>
              <Button variant="primary" size="sm" onClick={promote} loading={busy}>
                <TestTube2 className="h-4 w-4" />
                Promote to testing
              </Button>
            </>
          )}
          {pack.status === 'testing' && (
            <Button variant="primary" size="sm" onClick={activate} loading={busy}>
              <Rocket className="h-4 w-4" />
              Activate
            </Button>
          )}
        </div>
      </div>

      {message && (
        <GlassCard padding="sm" className={message.kind === 'error' ? 'border-red-500/40' : 'border-emerald-500/30'}>
          <p className={`text-[11px] ${message.kind === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>{message.text}</p>
        </GlassCard>
      )}

      <Tabs
        tabs={[
          { id: 'rules', label: 'Rules' },
          { id: 'diff', label: 'Diff vs active' },
          { id: 'backtest', label: 'Backtest' },
          { id: 'impact', label: 'Impact preview' },
        ]}
        activeTab={tab}
        onChange={setTab}
      />

      {tab === 'rules' && (
        pack.status === 'draft' ? (
          <RuleForm pack={draftPack} onChange={setDraftPack} />
        ) : (
          <GlassCard padding="sm">
            <p className="text-[11px] text-gray-500 mb-2">
              This pack is {pack.status} and immutable. To change it, create a new draft from it.
            </p>
            <pre className="text-[10px] text-gray-400 overflow-x-auto">{JSON.stringify(draftPack.rules, null, 2)}</pre>
          </GlassCard>
        )
      )}

      {tab === 'diff' && (diff ? <DiffView diff={diff} against={diffAgainst} /> : <p className="text-[11px] text-gray-500">No active pack to compare against yet.</p>)}

      {tab === 'backtest' && (
        <div className="space-y-4">
          <GlassCard padding="sm">
            <p className="text-[11px] text-gray-400 mb-2">
              Paste the account history to replay (JSON array of <code>EvaluationInput</code>), and optionally what your
              current platform reported for the same window.
            </p>
            <label className="block text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-1">Account inputs</label>
            <textarea
              value={backtestInputJson}
              onChange={(e) => setBacktestInputJson(e.target.value)}
              rows={6}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-[11px] font-mono text-gray-200 outline-none focus:border-red-500/50 mb-3"
            />
            <label className="block text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-1">Platform-reported breaches</label>
            <textarea
              value={providerReportedJson}
              onChange={(e) => setProviderReportedJson(e.target.value)}
              rows={3}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-[11px] font-mono text-gray-200 outline-none focus:border-red-500/50 mb-3"
            />
            <Button variant="primary" size="sm" onClick={runBacktest} loading={busy}>
              <PlayCircle className="h-4 w-4" />
              Run backtest
            </Button>
          </GlassCard>

          {latestBacktest && <ReconciliationView result={latestBacktest as never} />}

          {backtestHistory.length > 0 && (
            <GlassCard padding="sm">
              <p className="text-sm font-semibold text-white mb-2">Run history</p>
              <ul className="space-y-1">
                {backtestHistory.map((run) => (
                  <li key={String(run.id)} className="text-[11px] text-gray-400 flex items-center gap-2">
                    <Badge variant={run.status === 'complete' ? 'green' : 'yellow'}>{String(run.status)}</Badge>
                    <span>{String(run.created_at)}</span>
                    <span className="text-gray-600">·</span>
                    <span>{String(run.accounts_evaluated)} accounts</span>
                  </li>
                ))}
              </ul>
            </GlassCard>
          )}
        </div>
      )}

      {tab === 'impact' && (
        <div className="space-y-4">
          <Button variant="secondary" size="sm" onClick={loadImpact} loading={busy}>
            Preview impact on open accounts
          </Button>
          {impact && <ImpactView report={impact as never} note={impactNote ?? undefined} />}
        </div>
      )}
    </div>
  );
}
