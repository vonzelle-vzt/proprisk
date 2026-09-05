'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Save } from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';
import { Button } from '@/components/ui/button';
import { PresetPicker, type PresetOption } from '@/components/rulepack/preset-picker';
import { RuleForm } from '@/components/rulepack/rule-form';
import type { RulePack } from '@/lib/rulepack/schema';

type Step = 'preset' | 'tune';

export default function NewRulePackPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('preset');
  const [presets, setPresets] = useState<PresetOption[]>([]);
  const [selected, setSelected] = useState<PresetOption | null>(null);
  const [pack, setPack] = useState<RulePack | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/rulepack/presets', { cache: 'no-store' });
        const json = await res.json();
        setPresets(json.data ?? []);
      } catch {
        setPresets([]);
      }
    })();
  }, []);

  const choosePreset = (preset: PresetOption) => {
    setSelected(preset);
    setPack(preset.pack);
    setName(preset.pack.name);
    setStep('tune');
  };

  const save = async () => {
    if (!pack) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/rulepack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pack: { ...pack, name }, from_preset: selected?.id }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'Failed to save draft.');
        return;
      }
      if (json.demo) {
        setError('Demo mode: draft was not persisted, so there is nothing to open.');
        return;
      }
      router.push(`/rules/${json.data.id}`);
    } catch {
      setError('Failed to save draft.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-bold text-white">New Rule Pack</h1>
        <p className="text-[11px] text-gray-500 mt-1">
          {step === 'preset'
            ? 'Start from the shape closest to your rulebook, then tune it — every preset is a draft you review, not a published rulebook.'
            : 'Every threshold is shown as a percentage; it is stored as a fraction, so type "5" for 5%, not "0.05".'}
        </p>
      </div>

      {step === 'preset' && (
        <PresetPicker presets={presets} selectedId={selected?.id ?? null} onSelect={choosePreset} />
      )}

      {step === 'tune' && pack && (
        <div className="space-y-4">
          <GlassCard padding="sm">
            <label className="block text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-1">
              Pack name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-gray-200 outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/30"
            />
          </GlassCard>

          <RuleForm pack={pack} onChange={setPack} />

          {error && (
            <GlassCard padding="sm" className="border-red-500/40">
              <p className="text-[11px] text-red-400">{error}</p>
            </GlassCard>
          )}

          <div className="flex items-center justify-between pt-2">
            <Button variant="secondary" size="sm" onClick={() => setStep('preset')}>
              <ArrowLeft className="h-4 w-4" />
              Back to presets
            </Button>
            <Button variant="primary" size="sm" onClick={save} loading={saving}>
              <Save className="h-4 w-4" />
              Save as draft
            </Button>
          </div>
        </div>
      )}

      {step === 'preset' && presets.length === 0 && (
        <p className="text-[11px] text-gray-500">Loading presets…</p>
      )}
      {step === 'preset' && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" disabled>
            Next
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
