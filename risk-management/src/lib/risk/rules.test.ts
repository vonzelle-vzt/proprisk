import { describe, expect, it } from 'vitest';
import { normalizeAndValidateProfile, validateRiskProfileRules } from '@/lib/risk/rules';
import type { RiskRule } from '@/types/risk';

describe('risk rule validation', () => {
  it('accepts a valid, mixed rule set', () => {
    const rules: RiskRule[] = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        type: 'max_daily_loss',
        enabled: true,
        threshold: 1000,
        warning_threshold: 700,
        instrument_list: null,
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        type: 'instrument_blocklist',
        enabled: true,
        threshold: null,
        warning_threshold: null,
        instrument_list: ['XAUUSD', 'BTCUSD'],
      },
    ];

    const result = validateRiskProfileRules(rules);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects duplicate enabled rule types', () => {
    const rules: RiskRule[] = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        type: 'max_daily_loss',
        enabled: true,
        threshold: 1000,
        warning_threshold: 700,
        instrument_list: null,
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        type: 'max_daily_loss',
        enabled: true,
        threshold: 1200,
        warning_threshold: 800,
        instrument_list: null,
      },
    ];

    const result = validateRiskProfileRules(rules);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Duplicate enabled rule type'))).toBe(true);
  });

  it('normalizes blocklist symbols to uppercase', () => {
    const payload = {
      account_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      name: 'Smoke Profile',
      status: 'draft' as const,
      rules: [
        {
          type: 'instrument_blocklist' as const,
          enabled: true,
          instrument_list: ['xauusd', 'eurusd'],
        },
      ],
    };

    const { profile, validation } = normalizeAndValidateProfile(payload);
    expect(validation.valid).toBe(true);
    expect(profile.rules[0].instrument_list).toEqual(['XAUUSD', 'EURUSD']);
  });
});
