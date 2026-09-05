'use client';

import { GlassCard } from '@/components/ui/glass-card';
import { Badge } from '@/components/ui/badge';
import type { RulePack } from '@/lib/rulepack/schema';

export interface PresetOption {
  id: string;
  label: string;
  description: string;
  assetClass: 'forex' | 'futures';
  pack: RulePack;
}

interface PresetPickerProps {
  presets: PresetOption[];
  selectedId: string | null;
  onSelect: (preset: PresetOption) => void;
}

/**
 * Step 1 of the wizard. Shows the preset's own description, not a paraphrase
 * — that copy in presets.ts already explains the rule SHAPE ("Apex-style" is
 * a shape, not an affiliation), which is exactly what a firm needs to
 * recognise its own rulebook in one of these.
 */
export function PresetPicker({ presets, selectedId, onSelect }: PresetPickerProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {presets.map((preset) => {
        const selected = preset.id === selectedId;
        return (
          <GlassCard
            key={preset.id}
            hover
            padding="sm"
            glow={selected ? 'red' : 'none'}
            className={selected ? 'bg-white/10' : ''}
            onClick={() => onSelect(preset)}
          >
            <div className="flex items-center justify-between mb-1.5">
              <h3 className="text-sm font-semibold text-white">{preset.label}</h3>
              <Badge variant={preset.assetClass === 'futures' ? 'blue' : 'purple'}>
                {preset.assetClass}
              </Badge>
            </div>
            <p className="text-[11px] text-gray-400 leading-relaxed">{preset.description}</p>
          </GlassCard>
        );
      })}
    </div>
  );
}
