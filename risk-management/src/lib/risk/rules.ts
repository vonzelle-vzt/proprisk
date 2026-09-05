import { z } from 'zod';
import type { RiskProfile, RiskRule } from '@/types/risk';

const ruleTypeSchema = z.enum([
  'max_daily_loss',
  'max_position_risk_pct',
  'max_consecutive_losses',
  'instrument_blocklist',
]);

export const riskRuleSchema = z.object({
  id: z.string().uuid().optional(),
  type: ruleTypeSchema,
  enabled: z.boolean().default(true),
  threshold: z.number().positive().nullable().optional(),
  warning_threshold: z.number().positive().nullable().optional(),
  instrument_list: z.array(z.string().trim().min(1)).nullable().optional(),
});

export const createRiskProfileSchema = z.object({
  account_id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  rules: z.array(riskRuleSchema).min(1),
});

export interface ProfileValidationResult {
  valid: boolean;
  errors: string[];
}

function normalizeRule(rule: z.infer<typeof riskRuleSchema>): RiskRule {
  return {
    id: rule.id ?? crypto.randomUUID(),
    type: rule.type,
    enabled: rule.enabled,
    threshold: rule.threshold ?? null,
    warning_threshold: rule.warning_threshold ?? null,
    instrument_list: rule.instrument_list?.map((s) => s.toUpperCase()) ?? null,
  };
}

export function validateRiskProfileRules(rules: RiskRule[]): ProfileValidationResult {
  const errors: string[] = [];
  const enabledRules = rules.filter((rule) => rule.enabled);

  if (enabledRules.length === 0) {
    errors.push('At least one enabled risk rule is required.');
  }

  const typeCount = new Map<string, number>();
  for (const rule of enabledRules) {
    typeCount.set(rule.type, (typeCount.get(rule.type) || 0) + 1);
  }
  for (const [type, count] of typeCount.entries()) {
    if (count > 1) {
      errors.push(`Duplicate enabled rule type "${type}" is not allowed.`);
    }
  }

  for (const rule of enabledRules) {
    if (rule.type === 'instrument_blocklist') {
      if (!rule.instrument_list || rule.instrument_list.length === 0) {
        errors.push('Instrument blocklist rule must include at least one symbol.');
      }
      continue;
    }

    if (rule.threshold === null || rule.threshold === undefined) {
      errors.push(`Rule "${rule.type}" requires a threshold value.`);
    }
    if (
      rule.warning_threshold !== null &&
      rule.warning_threshold !== undefined &&
      rule.threshold !== null &&
      rule.warning_threshold >= rule.threshold
    ) {
      errors.push(`Rule "${rule.type}" warning_threshold must be below threshold.`);
    }
    if (rule.type === 'max_position_risk_pct' && rule.threshold !== null && rule.threshold > 100) {
      errors.push('max_position_risk_pct threshold cannot exceed 100.');
    }
  }

  return { valid: errors.length === 0, errors };
}

export function normalizeAndValidateProfile(
  input: z.infer<typeof createRiskProfileSchema>
): { profile: Omit<RiskProfile, 'id' | 'created_at' | 'updated_at' | 'version'>; validation: ProfileValidationResult } {
  const normalizedRules = input.rules.map(normalizeRule);
  const validation = validateRiskProfileRules(normalizedRules);

  return {
    profile: {
      account_id: input.account_id,
      name: input.name,
      status: input.status,
      rules: normalizedRules,
    },
    validation,
  };
}
