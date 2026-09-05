import { describe, expect, it } from 'vitest';
import {
  PRESET_RECHECK_DAYS,
  RULE_PACK_PRESETS,
  presetConfidence,
  presetConfidenceNotice,
  type PresetMeta,
} from './presets';

/**
 * A preset is a claim about somebody else's published rules. The risk is not
 * that a preset is wrong on the day it ships — it is that it silently stops
 * being right, and carries the authority of a shipped default while doing so.
 * These tests pin the machinery that keeps that visible.
 */

function withVerifiedAt(verifiedAt: string | null): PresetMeta {
  return { ...RULE_PACK_PRESETS[0], provenance: { source: 'https://example.test', verifiedAt } };
}

describe('preset provenance', () => {
  it('gives every shipped preset a source a human can open', () => {
    for (const preset of RULE_PACK_PRESETS) {
      expect(preset.provenance.source, `${preset.id} has no source`).toBeTruthy();
      expect(preset.provenance.source).toMatch(/^https:\/\//);
    }
  });

  // This is the honest state, and the test exists so that changing it requires
  // someone to actually do the verification rather than edit a comment. If a
  // preset is ever marked verified, this test fails and whoever verified it
  // updates the expectation deliberately.
  it('reports every shipped preset as UNVERIFIED — none has been checked against a live rulebook', () => {
    for (const preset of RULE_PACK_PRESETS) {
      expect(presetConfidence(preset), `${preset.id}`).toBe('unverified');
    }
  });
});

describe('confidence ages out', () => {
  const now = new Date('2026-08-05T00:00:00Z');

  it('is unverified when nobody has ever checked', () => {
    expect(presetConfidence(withVerifiedAt(null), now)).toBe('unverified');
  });

  it('is verified when checked recently', () => {
    expect(presetConfidence(withVerifiedAt('2026-07-20'), now)).toBe('verified');
  });

  it(`goes stale after ${PRESET_RECHECK_DAYS} days`, () => {
    // One day past the window.
    const past = new Date(now.getTime() - (PRESET_RECHECK_DAYS + 1) * 86_400_000);
    expect(presetConfidence(withVerifiedAt(past.toISOString().slice(0, 10)), now)).toBe('stale');
  });

  it('is still verified exactly on the boundary', () => {
    const boundary = new Date(now.getTime() - PRESET_RECHECK_DAYS * 86_400_000);
    expect(presetConfidence(withVerifiedAt(boundary.toISOString()), now)).toBe('verified');
  });
});

describe('the notice a customer reads', () => {
  const now = new Date('2026-08-05T00:00:00Z');

  it('tells an unverified preset to be checked, and points at the backtest', () => {
    const notice = presetConfidenceNotice(withVerifiedAt(null), now)!;
    expect(notice).toMatch(/has not been checked/i);
    expect(notice).toMatch(/backtest/i);
  });

  it('names the date when a preset has gone stale', () => {
    const notice = presetConfidenceNotice(withVerifiedAt('2020-01-01'), now)!;
    expect(notice).toContain('2020-01-01');
  });

  it('says nothing when a preset is current — no notice is the signal', () => {
    expect(presetConfidenceNotice(withVerifiedAt('2026-07-20'), now)).toBeNull();
  });
});
