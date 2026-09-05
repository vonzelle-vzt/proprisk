'use client';

import { Collapsible } from '@/components/ui/collapsible';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { ACCOUNT_PHASES, BREACH_ACTIONS, RULE_IDS, type AccountPhase, type BreachAction, type RuleId, type RulePack, type Rules } from '@/lib/rulepack/schema';

/**
 * Percent <-> fraction conversion, in one place.
 *
 * `schema.ts` is explicit that mixing the two is the classic 100x error in
 * this domain. Every input in this form is percent for the human; every value
 * that leaves it into the pack is a fraction, and this is the only place the
 * conversion happens.
 */
export function pctToFraction(pct: string | number): number {
  const n = typeof pct === 'string' ? Number(pct) : pct;
  return Number.isFinite(n) ? n / 100 : 0;
}
export function fractionToPct(fraction: number): string {
  return String(Number((fraction * 100).toFixed(4)));
}

const RULE_LABELS: Record<RuleId, string> = {
  daily_loss: 'Daily loss limit',
  drawdown: 'Drawdown',
  consistency: 'Consistency rule',
  min_trading_days: 'Minimum trading days',
  inactivity: 'Inactivity rule',
  position_limit: 'Position limit',
  overnight_holding: 'Overnight holding',
  weekend_holding: 'Weekend holding',
  news: 'News blackout',
  hft: 'HFT detector',
  martingale: 'Martingale detector',
  grid: 'Grid detector',
  copy_trading: 'Copy-trading detector',
};

const ALL_PHASES = [...ACCOUNT_PHASES];

/** What a rule looks like the instant it is turned on with no prior configuration. */
function defaultRule(id: RuleId): NonNullable<Rules[RuleId]> {
  const base = { enabled: true, applies_to_phases: ALL_PHASES, action: 'flag_for_review' as BreachAction };
  switch (id) {
    case 'daily_loss':
      return { ...base, basis: 'equity', include_open_pnl: true, threshold: { type: 'pct_of_initial', value: 0.05 } };
    case 'drawdown':
      return { ...base, mode: 'static', lock: 'never', basis: 'balance', threshold: { type: 'pct_of_initial', value: 0.1 } };
    case 'consistency':
      return { ...base, max_best_day_pct_of_profit: 0.4, evaluated_at: 'payout', min_profit_to_evaluate: 0 };
    case 'min_trading_days':
      return { ...base, min_days: 3, count_basis: 'any_trade' };
    case 'inactivity':
      return { ...base, max_idle_days: 14 };
    case 'position_limit':
      return { ...base, mode: 'fixed', fixed_limit: 10 };
    case 'overnight_holding':
    case 'weekend_holding':
      return { ...base, flat_by: '16:59' };
    case 'news':
      return { ...base, before_minutes: 5, after_minutes: 5, impact_levels: ['red'], applies_to: 'related_currency' };
    case 'hft':
      return { ...base, windows: [{ window_seconds: 60, max_trades: 10 }] };
    case 'martingale':
      return { ...base, min_losing_streak: 3, volume_multiplier: 1.5 };
    case 'grid':
      return { ...base, time_window_seconds: 60, lot_size_tolerance: 0.1, min_mirrored_trades: 3, score_threshold: 0.7 };
    case 'copy_trading':
      return { ...base, lag_window_seconds: 5, lot_size_tolerance: 0.1, min_copied_trades: 3, score_threshold: 0.7 };
  }
}

interface RuleFormProps {
  pack: RulePack;
  onChange: (next: RulePack) => void;
}

/**
 * Tuning form for every primitive in a pack.
 *
 * `enabled: false` and absence are the same thing in the schema, so toggling
 * a rule off here REMOVES it from the pack rather than disabling a control —
 * matching the contract exactly rather than leaving a lax-looking rule behind.
 */
export function RuleForm({ pack, onChange }: RuleFormProps) {
  const setRule = (id: RuleId, rule: NonNullable<Rules[RuleId]> | undefined) => {
    const rules = { ...pack.rules };
    if (rule === undefined) delete rules[id];
    else (rules as Record<string, unknown>)[id] = rule;
    onChange({ ...pack, rules });
  };

  const toggle = (id: RuleId, on: boolean) => {
    setRule(id, on ? (pack.rules[id] ?? defaultRule(id)) : undefined);
  };

  return (
    <div className="space-y-2">
      {RULE_IDS.map((id) => {
        const rule = pack.rules[id];
        const enabled = Boolean(rule?.enabled);
        return (
          <Collapsible key={id} title={RULE_LABELS[id]} defaultOpen={enabled} count={enabled ? undefined : 0}>
            <div className="flex items-center justify-between mb-3">
              <label className="flex items-center gap-2 text-[11px] text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => toggle(id, e.target.checked)}
                  className="rounded border-white/20 bg-white/5 text-red-600 focus:ring-red-500/50"
                />
                Enabled — {enabled ? 'this rule exists for this firm' : 'this rule does not exist for this firm'}
              </label>
              {!enabled && <Badge variant="silver">absent</Badge>}
            </div>

            {enabled && rule && (
              <div className="space-y-3">
                <CommonFields
                  action={rule.action}
                  phases={rule.applies_to_phases}
                  onActionChange={(action) => setRule(id, { ...rule, action })}
                  onPhasesChange={(phases) => setRule(id, { ...rule, applies_to_phases: phases })}
                />
                <RuleSpecificFields id={id} rule={rule} onChange={(next) => setRule(id, next)} />
              </div>
            )}
          </Collapsible>
        );
      })}
    </div>
  );
}

function CommonFields({
  action,
  phases,
  onActionChange,
  onPhasesChange,
}: {
  action: BreachAction;
  phases: AccountPhase[];
  onActionChange: (a: BreachAction) => void;
  onPhasesChange: (p: AccountPhase[]) => void;
}) {
  const togglePhase = (phase: AccountPhase) => {
    const next = phases.includes(phase) ? phases.filter((p) => p !== phase) : [...phases, phase];
    onPhasesChange(next.length > 0 ? next : phases);
  };

  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Action on breach">
        <Select
          value={action}
          onChange={(v) => onActionChange(v as BreachAction)}
          options={BREACH_ACTIONS.map((a) => ({ value: a, label: a.replace('_', ' ') }))}
        />
      </Field>
      <Field label="Applies to phases">
        <div className="flex gap-1.5">
          {ALL_PHASES.map((phase) => (
            <button
              key={phase}
              type="button"
              onClick={() => togglePhase(phase)}
              className={`px-2 py-1 rounded-lg text-[10px] border transition-colors ${
                phases.includes(phase)
                  ? 'bg-red-600/20 text-red-400 border-red-500/30'
                  : 'bg-white/5 text-gray-500 border-white/10'
              }`}
            >
              {phase}
            </button>
          ))}
        </div>
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}

function PctInput({ value, onChange }: { value: number; onChange: (fraction: number) => void }) {
  return (
    <div className="relative">
      <input
        type="number"
        step="0.01"
        min="0"
        max="100"
        value={fractionToPct(value)}
        onChange={(e) => onChange(pctToFraction(e.target.value))}
        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 pr-7 text-sm text-gray-200 outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/30"
      />
      <span className="absolute right-3 top-2 text-xs text-gray-500">%</span>
    </div>
  );
}

function NumberInput({ value, onChange, ...rest }: { value: number; onChange: (n: number) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-gray-200 outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/30"
      {...rest}
    />
  );
}

function TimeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="time"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-gray-200 outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/30 [color-scheme:dark]"
    />
  );
}

/** Fields specific to each primitive. Threshold-bearing rules always show percent, never a raw fraction. */
function RuleSpecificFields({
  id,
  rule,
  onChange,
}: {
  id: RuleId;
  rule: NonNullable<Rules[RuleId]>;
  onChange: (next: NonNullable<Rules[RuleId]>) => void;
}) {
  switch (id) {
    case 'daily_loss': {
      const r = rule as Rules['daily_loss'] & object;
      return (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Threshold">
            <PctInput value={r.threshold.value} onChange={(v) => onChange({ ...r, threshold: { ...r.threshold, value: v } })} />
          </Field>
          <Field label="Basis">
            <Select
              value={r.basis}
              onChange={(v) => onChange({ ...r, basis: v as typeof r.basis })}
              options={[
                { value: 'balance', label: 'Balance (realised only)' },
                { value: 'equity', label: 'Equity (realised + open)' },
                { value: 'highest_equity_of_day', label: 'Highest equity of day' },
              ]}
            />
          </Field>
        </div>
      );
    }
    case 'drawdown': {
      const r = rule as Rules['drawdown'] & object;
      return (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Threshold">
            <PctInput value={r.threshold.value} onChange={(v) => onChange({ ...r, threshold: { ...r.threshold, value: v } })} />
          </Field>
          <Field label="Basis">
            <Select
              value={r.basis}
              onChange={(v) => onChange({ ...r, basis: v as typeof r.basis })}
              options={[
                { value: 'balance', label: 'Balance' },
                { value: 'equity', label: 'Equity' },
              ]}
            />
          </Field>
          <Field label="Mode">
            <Select
              value={r.mode}
              onChange={(v) => onChange({ ...r, mode: v as typeof r.mode, lock: v === 'static' ? 'never' : r.lock })}
              options={[
                { value: 'static', label: 'Static — floor never moves' },
                { value: 'trailing_intraday', label: 'Trailing (intraday) — harshest' },
                { value: 'trailing_eod', label: 'Trailing (end-of-day)' },
              ]}
            />
          </Field>
          <Field label="Lock">
            <Select
              value={r.lock}
              onChange={(v) => onChange({ ...r, lock: v as typeof r.lock })}
              options={
                r.mode === 'static'
                  ? [{ value: 'never', label: 'Never (static floor)' }]
                  : [
                      { value: 'never', label: 'Never — floor trails forever' },
                      { value: 'at_initial_balance', label: 'At initial balance' },
                      { value: 'at_initial_plus', label: 'At initial balance + buffer' },
                    ]
              }
            />
          </Field>
          {r.lock === 'at_initial_plus' && (
            <Field label="Lock buffer ($)">
              <NumberInput value={r.lock_buffer ?? 0} onChange={(v) => onChange({ ...r, lock_buffer: v })} min={0} />
            </Field>
          )}
        </div>
      );
    }
    case 'consistency': {
      const r = rule as Rules['consistency'] & object;
      return (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Max best day (% of total profit)">
            <PctInput value={r.max_best_day_pct_of_profit} onChange={(v) => onChange({ ...r, max_best_day_pct_of_profit: v })} />
          </Field>
          <Field label="Evaluated at">
            <Select
              value={r.evaluated_at}
              onChange={(v) => onChange({ ...r, evaluated_at: v as typeof r.evaluated_at })}
              options={[
                { value: 'payout', label: 'Payout request only' },
                { value: 'continuous', label: 'Continuously' },
              ]}
            />
          </Field>
          <Field label="Minimum profit to evaluate ($)">
            <NumberInput value={r.min_profit_to_evaluate} onChange={(v) => onChange({ ...r, min_profit_to_evaluate: v })} min={0} />
          </Field>
        </div>
      );
    }
    case 'min_trading_days': {
      const r = rule as Rules['min_trading_days'] & object;
      return (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Minimum days">
            <NumberInput value={r.min_days} onChange={(v) => onChange({ ...r, min_days: v })} min={1} step={1} />
          </Field>
          <Field label="Count basis">
            <Select
              value={r.count_basis}
              onChange={(v) => onChange({ ...r, count_basis: v as typeof r.count_basis })}
              options={[
                { value: 'any_trade', label: 'Any day traded' },
                { value: 'profitable', label: 'Profitable days only' },
              ]}
            />
          </Field>
        </div>
      );
    }
    case 'inactivity': {
      const r = rule as Rules['inactivity'] & object;
      return (
        <Field label="Max idle days">
          <NumberInput value={r.max_idle_days} onChange={(v) => onChange({ ...r, max_idle_days: v })} min={1} step={1} />
        </Field>
      );
    }
    case 'position_limit': {
      const r = rule as Rules['position_limit'] & object;
      return (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Mode">
            <Select
              value={r.mode}
              onChange={(v) => onChange({ ...r, mode: v as typeof r.mode })}
              options={[
                { value: 'fixed', label: 'One ceiling for every account' },
                { value: 'by_account_size', label: 'By account size' },
              ]}
            />
          </Field>
          {r.mode === 'fixed' ? (
            <Field label="Fixed limit (contracts/lots)">
              <NumberInput value={r.fixed_limit ?? 0} onChange={(v) => onChange({ ...r, fixed_limit: v })} min={0} />
            </Field>
          ) : (
            <Field label="Limits by size">
              <textarea
                value={JSON.stringify(r.limits_by_size ?? {}, null, 0)}
                onChange={(e) => {
                  try {
                    onChange({ ...r, limits_by_size: JSON.parse(e.target.value) });
                  } catch {
                    /* invalid JSON while typing — keep the previous value */
                  }
                }}
                rows={2}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono text-gray-200 outline-none focus:border-red-500/50"
                placeholder='{"25000": 4, "50000": 10}'
              />
            </Field>
          )}
        </div>
      );
    }
    case 'overnight_holding':
    case 'weekend_holding': {
      const r = rule as Rules['overnight_holding'] & object;
      return (
        <Field label="Flat by (session wall-clock)">
          <TimeInput value={r.flat_by} onChange={(v) => onChange({ ...r, flat_by: v })} />
        </Field>
      );
    }
    case 'news': {
      const r = rule as Rules['news'] & object;
      return (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Minutes before">
            <NumberInput value={r.before_minutes} onChange={(v) => onChange({ ...r, before_minutes: v })} min={0} step={1} />
          </Field>
          <Field label="Minutes after">
            <NumberInput value={r.after_minutes} onChange={(v) => onChange({ ...r, after_minutes: v })} min={0} step={1} />
          </Field>
          <Field label="Impact levels">
            <div className="flex gap-1.5">
              {(['red', 'orange', 'yellow'] as const).map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => {
                    const has = r.impact_levels.includes(level);
                    const next = has ? r.impact_levels.filter((l) => l !== level) : [...r.impact_levels, level];
                    if (next.length > 0) onChange({ ...r, impact_levels: next });
                  }}
                  className={`px-2 py-1 rounded-lg text-[10px] border ${
                    r.impact_levels.includes(level)
                      ? 'bg-red-600/20 text-red-400 border-red-500/30'
                      : 'bg-white/5 text-gray-500 border-white/10'
                  }`}
                >
                  {level}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Applies to">
            <Select
              value={r.applies_to}
              onChange={(v) => onChange({ ...r, applies_to: v as typeof r.applies_to })}
              options={[
                { value: 'related_currency', label: 'Related currency only' },
                { value: 'all_instruments', label: 'All instruments' },
              ]}
            />
          </Field>
        </div>
      );
    }
    case 'martingale': {
      const r = rule as Rules['martingale'] & object;
      return (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Min losing streak">
            <NumberInput value={r.min_losing_streak} onChange={(v) => onChange({ ...r, min_losing_streak: v })} min={1} step={1} />
          </Field>
          <Field label="Volume multiplier (> 1x)">
            <NumberInput value={r.volume_multiplier} onChange={(v) => onChange({ ...r, volume_multiplier: v })} min={1.01} step={0.1} />
          </Field>
        </div>
      );
    }
    case 'hft': {
      const r = rule as Rules['hft'] & object;
      return (
        <Field label="Windows (window_seconds : max_trades)">
          <textarea
            value={JSON.stringify(r.windows)}
            onChange={(e) => {
              try {
                onChange({ ...r, windows: JSON.parse(e.target.value) });
              } catch {
                /* invalid JSON while typing — keep the previous value */
              }
            }}
            rows={2}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono text-gray-200 outline-none focus:border-red-500/50"
          />
        </Field>
      );
    }
    case 'grid': {
      const r = rule as Rules['grid'] & object;
      return (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Time window (s)">
            <NumberInput value={r.time_window_seconds} onChange={(v) => onChange({ ...r, time_window_seconds: v })} min={1} step={1} />
          </Field>
          <Field label="Lot size tolerance">
            <PctInput value={r.lot_size_tolerance} onChange={(v) => onChange({ ...r, lot_size_tolerance: v })} />
          </Field>
          <Field label="Min mirrored trades">
            <NumberInput value={r.min_mirrored_trades} onChange={(v) => onChange({ ...r, min_mirrored_trades: v })} min={1} step={1} />
          </Field>
          <Field label="Score threshold">
            <PctInput value={r.score_threshold} onChange={(v) => onChange({ ...r, score_threshold: v })} />
          </Field>
        </div>
      );
    }
    case 'copy_trading': {
      const r = rule as Rules['copy_trading'] & object;
      return (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Lag window (s)">
            <NumberInput value={r.lag_window_seconds} onChange={(v) => onChange({ ...r, lag_window_seconds: v })} min={1} step={1} />
          </Field>
          <Field label="Lot size tolerance">
            <PctInput value={r.lot_size_tolerance} onChange={(v) => onChange({ ...r, lot_size_tolerance: v })} />
          </Field>
          <Field label="Min copied trades">
            <NumberInput value={r.min_copied_trades} onChange={(v) => onChange({ ...r, min_copied_trades: v })} min={1} step={1} />
          </Field>
          <Field label="Score threshold">
            <PctInput value={r.score_threshold} onChange={(v) => onChange({ ...r, score_threshold: v })} />
          </Field>
        </div>
      );
    }
  }
}
