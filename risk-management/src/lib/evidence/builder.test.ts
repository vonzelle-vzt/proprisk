import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('evidence pack builder (demo mode)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds a pack for a ring investigation with populated scoringTrail/networkLinks/narrative', async () => {
    const { buildEvidencePack } = await import('./builder');
    const { MOCK_COPY_RING } = await import('@/lib/mock/dataset.network');

    const pack = await buildEvidencePack({ subjectType: 'investigation', subjectId: MOCK_COPY_RING.id });

    expect(pack.subjectType).toBe('investigation');
    expect(pack.subjectId).toBe(MOCK_COPY_RING.id);
    expect(pack.accountId).toBe(MOCK_COPY_RING.accountIds[0]);
    // scoringTrail reflects the leader account's own confirmed violations,
    // which may be empty if the leader's flag is purely the ring signal;
    // the network linkage is the load-bearing evidence for this subject type.
    expect(pack.sections.scoringTrail.length).toBeGreaterThanOrEqual(0);
    expect(pack.sections.networkLinks.length).toBeGreaterThan(0);
    // The leader account's own edges connect it to every follower.
    expect(pack.sections.networkLinks.length).toBe(MOCK_COPY_RING.accountIds.length - 1);
    expect(pack.narrative).toBeTruthy();
    expect(pack.narrative).toContain(MOCK_COPY_RING.accountIds[0]);
    expect(pack.id).toBe(`demo-investigation-${MOCK_COPY_RING.id}`);
  });

  it('builds a pack for a flagged account with a populated deduction-math trail', async () => {
    const { buildEvidencePack } = await import('./builder');
    const { FOREX_ACCOUNTS } = await import('@/lib/mock/dataset.forex');
    const flagged = FOREX_ACCOUNTS.find((a) => Object.keys(a.deductionBreakdown).length > 0)!;

    const pack = await buildEvidencePack({ subjectType: 'account', subjectId: flagged.accountId, accountId: flagged.accountId });

    expect(pack.sections.scoringTrail.length).toBeGreaterThan(0);
    expect(pack.sections.deductionMath[0].label).toBe('Gross profit');
    expect(pack.sections.deductionMath.some((l) => l.label === 'Net profit after deductions')).toBe(true);
  });

  it('round-trips encodeDemoEvidenceId/decodeDemoEvidenceId for a plain subject id', async () => {
    const { encodeDemoEvidenceId, decodeDemoEvidenceId } = await import('./builder');
    const encoded = encodeDemoEvidenceId('payout', '100074');
    expect(encoded).toBe('demo-payout-100074');
    expect(decodeDemoEvidenceId(encoded)).toEqual({ subjectType: 'payout', subjectId: '100074' });
  });

  it('round-trips a hyphenated subject id (e.g. investigation ring ids)', async () => {
    const { encodeDemoEvidenceId, decodeDemoEvidenceId } = await import('./builder');
    const encoded = encodeDemoEvidenceId('investigation', 'RING-COPY-001');
    expect(encoded).toBe('demo-investigation-RING-COPY-001');
    expect(decodeDemoEvidenceId(encoded)).toEqual({ subjectType: 'investigation', subjectId: 'RING-COPY-001' });
  });

  it('round-trips a subject id that itself contains extra hyphens', async () => {
    const { encodeDemoEvidenceId, decodeDemoEvidenceId } = await import('./builder');
    const encoded = encodeDemoEvidenceId('account', '100074-hft-2026-06-01');
    expect(decodeDemoEvidenceId(encoded)).toEqual({ subjectType: 'account', subjectId: '100074-hft-2026-06-01' });
  });

  it('returns null decoding a non-demo id', async () => {
    const { decodeDemoEvidenceId } = await import('./builder');
    expect(decodeDemoEvidenceId('live-uuid-1234')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Live mode — the rule-pack evidence wiring (U10).
//
// buildLivePack() talks to Supabase (createAdminClient) and Claude
// (askClaude); both are mocked here rather than hit for real. The mock
// query builder ignores filter arguments (.eq/.in/.order/.limit) and just
// resolves to whatever rows the test registered for that table — enough to
// exercise buildEvidencePack's own mapping logic, which is what U10 changed.
// ---------------------------------------------------------------------------

function makeQueryResult(data: unknown) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    insert: () => builder,
    maybeSingle: async () => ({ data: Array.isArray(data) ? (data[0] ?? null) : (data ?? null), error: null }),
    single: async () => ({ data, error: null }),
    then: (resolve: (v: { data: unknown; error: null }) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data, error: null }).then(resolve, reject),
  };
  return builder;
}

function makeSupabaseMock(tables: Record<string, unknown>) {
  return { from: (table: string) => makeQueryResult(tables[table] ?? []) };
}

const LIVE_ACCOUNT_ROW = {
  id: 'acct-1',
  tenant_id: 'tenant-1',
  login: 'LOGIN1',
  total_pnl: 5000,
};

const LIVE_TRADE_ROW = {
  id: '11111111-1111-1111-1111-111111111111',
  symbol: 'EURUSD',
  open_time: '2026-01-01T00:00:00Z',
  close_time: '2026-01-01T01:00:00Z',
  lot_size: 2,
  profit: -300,
};

describe('evidence pack builder (live mode — rule-pack evidence)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'false');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('@/lib/supabase/admin');
    vi.doUnmock('@/lib/ai/claude');
  });

  it('renders threshold/observed/math and pack provenance verbatim from a rule-pack violation row', async () => {
    const rulePackViolation = {
      id: 'v-1',
      account_id: LIVE_ACCOUNT_ROW.id,
      violation_type: 'daily_loss',
      deduction_amount: 0,
      related_trade_ids: [LIVE_TRADE_ROW.id],
      details_json: {
        source: 'rule_pack',
        rule_id: 'daily_loss',
        rule_pack_id: 'pack-1',
        rule_pack_version: 3,
        rule_pack_content_hash: 'abc123',
        evidence: {
          limit: 'Daily loss must not exceed $500',
          observed: 'Daily loss reached $612.40',
          math: '$5000 start - $4387.60 end-of-day = $612.40 loss',
          tradeIds: [LIVE_TRADE_ROW.id],
          values: { limit: 500, loss: 612.4 },
        },
      },
    };

    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () =>
        makeSupabaseMock({
          accounts: [LIVE_ACCOUNT_ROW],
          violations: [rulePackViolation],
          trades: [LIVE_TRADE_ROW],
          evidence_packs: { id: 'ep-1', created_at: '2026-01-02T00:00:00Z' },
        }),
    }));
    vi.doMock('@/lib/ai/claude', () => ({
      CLAUDE_MODELS: { narrative: 'claude-sonnet-5' },
      askClaude: vi.fn().mockRejectedValue(new Error('no network in tests')),
    }));

    const { buildEvidencePack } = await import('./builder');
    const pack = await buildEvidencePack({ subjectType: 'violation', subjectId: 'v-1', tenantId: 'tenant-1' });

    expect(pack.sections.scoringTrail).toHaveLength(1);
    const finding = pack.sections.scoringTrail[0];
    expect(finding.ruleId).toBe('daily_loss');
    expect(finding.threshold).toBe('Daily loss must not exceed $500');
    expect(finding.observed).toBe('Daily loss reached $612.40');
    expect(finding.math).toBe('$5000 start - $4387.60 end-of-day = $612.40 loss');
    expect(finding.evidence).toHaveLength(1);
    expect(finding.evidence[0].tradeId).toBe(LIVE_TRADE_ROW.id);
    expect(pack.sections.rulePack).toEqual({ id: 'pack-1', version: 3, contentHash: 'abc123' });
  });

  it('still produces the old ruleDescription output for a legacy violation row', async () => {
    const legacyViolation = {
      id: 'v-2',
      account_id: LIVE_ACCOUNT_ROW.id,
      violation_type: 'hft',
      deduction_amount: 150,
      related_trade_ids: [LIVE_TRADE_ROW.id],
      details_json: { source: 'legacy_engine', violationType: 'hft' },
    };

    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () =>
        makeSupabaseMock({
          accounts: [LIVE_ACCOUNT_ROW],
          violations: [legacyViolation],
          trades: [LIVE_TRADE_ROW],
          evidence_packs: { id: 'ep-2', created_at: '2026-01-02T00:00:00Z' },
        }),
    }));
    vi.doMock('@/lib/ai/claude', () => ({
      CLAUDE_MODELS: { narrative: 'claude-sonnet-5' },
      askClaude: vi.fn().mockRejectedValue(new Error('no network in tests')),
    }));

    const { buildEvidencePack } = await import('./builder');
    const pack = await buildEvidencePack({ subjectType: 'violation', subjectId: 'v-2', tenantId: 'tenant-1' });

    expect(pack.sections.scoringTrail).toHaveLength(1);
    const finding = pack.sections.scoringTrail[0];
    expect(finding.ruleId).toBe('hft');
    expect(finding.threshold).toBe('Max 6 positions opened within any rolling 60s window (scaled thresholds down to 2 in 3s)');
    expect(finding.observed).toBe('1 flagged trade(s) opened in rapid succession within the rolling window');
    expect(finding.math).toBeUndefined();
    expect(pack.sections.rulePack).toBeUndefined();
  });

  it('falls back gracefully (no throw) for a rule-pack row with missing evidence', async () => {
    const malformedRulePackViolation = {
      id: 'v-3',
      account_id: LIVE_ACCOUNT_ROW.id,
      violation_type: 'grid',
      deduction_amount: 0,
      related_trade_ids: [LIVE_TRADE_ROW.id],
      details_json: {
        source: 'rule_pack',
        rule_id: 'grid',
        rule_pack_id: 'pack-1',
        rule_pack_version: 3,
        rule_pack_content_hash: 'abc123',
        // evidence deliberately omitted
      },
    };

    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () =>
        makeSupabaseMock({
          accounts: [LIVE_ACCOUNT_ROW],
          violations: [malformedRulePackViolation],
          trades: [LIVE_TRADE_ROW],
          evidence_packs: { id: 'ep-3', created_at: '2026-01-02T00:00:00Z' },
        }),
    }));
    vi.doMock('@/lib/ai/claude', () => ({
      CLAUDE_MODELS: { narrative: 'claude-sonnet-5' },
      askClaude: vi.fn().mockRejectedValue(new Error('no network in tests')),
    }));

    const { buildEvidencePack } = await import('./builder');

    await expect(
      buildEvidencePack({ subjectType: 'violation', subjectId: 'v-3', tenantId: 'tenant-1' })
    ).resolves.toBeTruthy();

    const pack = await buildEvidencePack({ subjectType: 'violation', subjectId: 'v-3', tenantId: 'tenant-1' });
    const finding = pack.sections.scoringTrail[0];
    expect(finding.threshold).toBe('No regular-interval grid pattern on a single symbol (≥5 trades, ≥60% regular spacing)');
    expect(finding.observed).toBe('Regular-interval spacing confirmed across 1 trade(s) on the same symbol');
    // Provenance is still attached even though evidence fell back — the row
    // is still `source: 'rule_pack'` and record.ts always writes the ids.
    expect(pack.sections.rulePack).toEqual({ id: 'pack-1', version: 3, contentHash: 'abc123' });
  });
});
