import { describe, expect, it } from 'vitest';
import { normaliseProviderType, runBacktest, type ProviderReportedBreach } from './backtest';
import { presetById } from './presets';
import type { EvaluationInput } from './types';

const PACK_VERSION = 'v1';

function accountInput(id: string, dayLoss: number): EvaluationInput {
  return {
    account: {
      id,
      login: id,
      phase: 'funded',
      startingBalance: 100_000,
      currentBalance: 100_000 - dayLoss,
      currentEquity: 100_000 - dayLoss,
    },
    trades: [
      {
        id: `${id}-t1`,
        symbol: 'EURUSD',
        openTime: '2026-03-02T10:00:00Z',
        closeTime: '2026-03-02T11:00:00Z',
        profit: -dayLoss,
        size: 1,
        isOpen: false,
      },
    ],
    now: '2026-03-10T00:00:00Z',
  };
}

const ftmo = presetById('ftmo-style')!.pack;

describe('shadow mode reconciles against the firm’s own platform', () => {
  it('agrees when both find the same breach', () => {
    const provider: ProviderReportedBreach[] = [
      { accountId: 'acc-1', type: 'max_daily_loss', at: '2026-03-02T12:00:00Z' },
    ];

    const result = runBacktest(ftmo, PACK_VERSION, [accountInput('acc-1', 6_000)], provider);

    expect(result.reconciliation.agreed).toHaveLength(1);
    expect(result.reconciliation.engineOnly).toHaveLength(0);
    expect(result.reconciliation.providerOnly).toHaveLength(0);
    expect(result.verdict.safeToActivate).toBe(true);
    expect(result.verdict.summary).toMatch(/none missed/);
  });

  // The blocking case: activating a pack that misses a breach the firm's own
  // platform enforced would silently relax their rules.
  it('REFUSES to call a pack safe when it misses a breach the platform caught', () => {
    const provider: ProviderReportedBreach[] = [
      { accountId: 'acc-2', type: 'max_daily_loss', at: '2026-03-02T12:00:00Z' },
    ];

    // A $1,000 loss is well inside FTMO's 5% ($5,000) limit, so the engine
    // finds nothing while the platform reported a breach.
    const result = runBacktest(ftmo, PACK_VERSION, [accountInput('acc-2', 1_000)], provider);

    expect(result.reconciliation.providerOnly).toHaveLength(1);
    expect(result.verdict.safeToActivate).toBe(false);
    expect(result.verdict.summary).toMatch(/would relax your rules/i);
  });

  it('surfaces breaches the incumbent missed without blocking activation', () => {
    const result = runBacktest(ftmo, PACK_VERSION, [accountInput('acc-3', 6_000)], []);

    expect(result.reconciliation.engineOnly).toHaveLength(1);
    expect(result.verdict.safeToActivate).toBe(true);
    expect(result.verdict.summary).toMatch(/mis-set parameter/);
  });

  // Matching on exact timestamps would report every genuine agreement as a
  // disagreement, because platforms stamp a breach when their job noticed it.
  it('matches on account and rule, not on exact timestamp', () => {
    const provider: ProviderReportedBreach[] = [
      { accountId: 'acc-4', type: 'daily_loss', at: '2026-03-02T23:59:00Z' },
    ];

    const result = runBacktest(ftmo, PACK_VERSION, [accountInput('acc-4', 6_000)], provider);
    expect(result.reconciliation.agreed).toHaveLength(1);
  });

  it('leaves an unmapped platform label unmatched rather than force-fitting it', () => {
    expect(normaliseProviderType('max_daily_loss')).toBe('daily_loss');
    expect(normaliseProviderType('some_bespoke_rule')).toBe('some_bespoke_rule');

    const provider: ProviderReportedBreach[] = [
      { accountId: 'acc-5', type: 'some_bespoke_rule', at: '2026-03-02T12:00:00Z' },
    ];
    const result = runBacktest(ftmo, PACK_VERSION, [accountInput('acc-5', 6_000)], provider);

    expect(result.reconciliation.providerOnly).toHaveLength(1);
    expect(result.reconciliation.providerOnly[0].ruleId).toBe('some_bespoke_rule');
  });
});

describe('a run that could not evaluate everything does not claim coverage', () => {
  it('blocks activation when a rule was skipped', () => {
    const apex = presetById('apex-style')!.pack; // intraday drawdown needs snapshots
    const result = runBacktest(
      apex,
      PACK_VERSION,
      [
        {
          ...accountInput('acc-6', 1_000),
          account: { ...accountInput('acc-6', 1_000).account, startingBalance: 50_000 },
        },
      ],
      []
    );

    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.verdict.safeToActivate).toBe(false);
    expect(result.verdict.summary).toMatch(/does not prove coverage/);
  });

  it('reports one finding per rule+reason, not one per account', () => {
    const apex = presetById('apex-style')!.pack;
    const many = Array.from({ length: 25 }, (_, i) => ({
      ...accountInput(`acc-${i}`, 100),
      account: { ...accountInput(`acc-${i}`, 100).account, id: `acc-${i}`, startingBalance: 50_000 },
    }));

    const result = runBacktest(apex, PACK_VERSION, many, []);

    expect(result.accountsEvaluated).toBe(25);
    // The drawdown-needs-snapshots finding appears once, not 25 times.
    const drawdownSkips = result.skipped.filter((s) => s.ruleId === 'drawdown');
    expect(drawdownSkips).toHaveLength(1);
  });
});

describe('shadow mode shares the live code path', () => {
  it('produces the same decisions the live evaluator would', async () => {
    const { evaluateRulePack } = await import('./evaluate');
    const input = accountInput('acc-7', 6_000);

    const live = evaluateRulePack(ftmo, input, PACK_VERSION);
    const shadow = runBacktest(ftmo, PACK_VERSION, [input], []);

    expect(shadow.decisions.map((d) => d.idempotencyKey)).toEqual(
      live.decisions.map((d) => d.idempotencyKey)
    );
  });
});
