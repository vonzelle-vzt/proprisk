import { describe, expect, it } from 'vitest';
import { draftTraderNotice } from './notice';
import type { EvidencePack } from '@/lib/evidence/types';

/**
 * Covers the one behaviour added for per-violation reports: the notice can now
 * close with "Full decision record: [link]" (docs/HOW-IT-WORKS.md §2 Flow 3).
 * The existing single-argument signature has callers in the enforcement path,
 * so "still works with no options" is as load-bearing as the new line itself.
 */

function pack(overrides: Partial<EvidencePack> = {}): EvidencePack {
  return {
    id: 'pack-1',
    subjectType: 'violation',
    subjectId: 'v-1',
    accountId: '1001',
    assetClass: 'forex',
    title: 'Daily loss breach',
    createdAt: '2026-03-03T09:00:00.000Z',
    createdBy: 'dana@firm.com',
    narrative: 'The account exceeded its daily loss limit.',
    sections: {
      accountSummary: {},
      scoringTrail: [
        {
          ruleId: 'daily_loss',
          ruleLabel: 'Daily Loss Limit',
          threshold: '$5,000.00',
          observed: '$6,000.00',
          verdict: 'breach',
          evidence: [],
          deductionAmount: 6000,
        },
      ],
      deductionMath: [],
      newsEvents: [],
      networkLinks: [],
      auditEntries: [],
      decisionHistory: [],
    },
    ...overrides,
  };
}

describe('draftTraderNotice', () => {
  it('keeps working with no options at all', () => {
    const draft = draftTraderNotice(pack());
    expect(draft.subject).toContain('Daily Loss Limit');
    expect(draft.citedRules).toEqual(['Daily Loss Limit']);
    expect(draft.totalDeduction).toBe(6000);
    expect(draft.body).not.toContain('Full decision record');
  });

  it('omits the line when the options object carries no url', () => {
    expect(draftTraderNotice(pack(), {}).body).not.toContain('Full decision record');
  });

  it('closes with the decision-record link when one is supplied', () => {
    const url = 'https://firm.example/api/trader/abc/violations/v-1/report';
    const body = draftTraderNotice(pack(), { reportUrl: url }).body;

    expect(body).toContain(`Full decision record: ${url}`);
    // Last thing the trader reads, after the arithmetic — the notice ends on
    // "here is the whole record", not on the amount being taken.
    expect(body.trimEnd().endsWith(`Full decision record: ${url}`)).toBe(true);
  });

  it('still drafts a notice when the pack has no narrative or findings', () => {
    const draft = draftTraderNotice(
      pack({ narrative: null, sections: { ...pack().sections, scoringTrail: [] } }),
      { reportUrl: 'https://firm.example/r' }
    );

    expect(draft.citedRules).toEqual([]);
    expect(draft.totalDeduction).toBe(0);
    expect(draft.body).toContain('No narrative summary available.');
    expect(draft.body).toContain('No individual rule findings recorded.');
    expect(draft.body).toContain('Full decision record: https://firm.example/r');
  });
});
