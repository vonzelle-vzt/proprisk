import { describe, expect, it } from 'vitest';
import { composeDecisionRationale } from './decision';
import type { PayoutRecord } from '@/types/payouts';

function record(overrides: Partial<PayoutRecord> = {}): PayoutRecord {
  return {
    id: 'payout-1',
    orderNumber: 'ORD-1',
    accountId: 'account-1',
    kycStatus: 'Verified',
    ipMismatch: false,
    platformViolations: [],
    notes: '',
    status: 'Pending',
    firstName: 'Jane',
    lastName: 'Doe',
    amount: 1000,
    clientAmount: 800,
    profitSharePercentage: 80,
    ...overrides,
  };
}

describe('composeDecisionRationale', () => {
  it('cites rules from a fresh analysis result with per-rule trade counts and math', () => {
    const rec = record();
    const analysis = {
      deduction_breakdown: { hft: 150, martingale: 50 },
      violation_details: {
        hft: [{ trade_id: 't1', explanation: 'rapid trading', amount: 100 }, { trade_id: 't2', explanation: 'rapid trading', amount: 50 }],
        martingale: [{ trade_id: 't3', explanation: 'lot escalation', amount: 50 }],
      },
      total_deductions: 200,
      violation_count: 3,
    };

    const { rationale, explanation } = composeDecisionRationale({ record: rec, analysis, decision: 'approve' });

    expect(rationale.citedRules).toHaveLength(2);
    // sorted by deduction desc
    expect(rationale.citedRules[0].ruleId).toBe('hft');
    expect(rationale.citedRules[0].tradeCount).toBe(2);
    expect(rationale.citedRules[0].observed).toContain('2 flagged trades');
    expect(rationale.citedRules[1].ruleId).toBe('martingale');

    // requestedAmount: profitSharePercentage 80, clientAmount 800 => 800/0.8 = 1000
    expect(rationale.math.requestedAmount).toBe(1000);
    expect(rationale.math.totalDeductions).toBe(200);
    expect(rationale.math.adjustedAmount).toBe(800);
    expect(explanation).toContain('HFT');
    expect(explanation).toContain('Martingale');
  });

  it('falls back to record.platformDeductions when analysis is absent', () => {
    const rec = record({
      platformDeductions: {
        totalDeductions: 120,
        violationCount: 1,
        percentOfStartingBalance: 1.2,
        percentOfTotalPL: 12,
        breakdownByType: { grid: 120 },
      },
    });

    const { rationale } = composeDecisionRationale({ record: rec, analysis: null, decision: 'approve' });

    expect(rationale.citedRules).toHaveLength(1);
    expect(rationale.citedRules[0].ruleId).toBe('grid');
    expect(rationale.citedRules[0].deduction).toBe(120);
    expect(rationale.citedRules[0].observed).toBe('Flagged by platform-side deduction calculation');
    expect(rationale.math.totalDeductions).toBe(120);
  });

  it('reports no confirmed violations when there is no analysis and no platform deductions', () => {
    const rec = record();
    const { rationale, explanation } = composeDecisionRationale({ record: rec, analysis: null, decision: 'approve' });

    expect(rationale.citedRules).toHaveLength(0);
    expect(rationale.math.totalDeductions).toBe(0);
    expect(rationale.math.adjustedAmount).toBe(rationale.math.requestedAmount);
    expect(rationale.decisionBasis[0]).toContain('No confirmed rule violations');
    expect(explanation).toContain('No confirmed rule violations');
  });

  it('uses amount/clientAmount directly when profitSharePercentage is 0, missing, or out of (0,100)', () => {
    const rec = record({ profitSharePercentage: 0, amount: 500, clientAmount: 400 });
    const { rationale } = composeDecisionRationale({ record: rec, analysis: null, decision: 'approve' });
    expect(rationale.math.requestedAmount).toBe(500);
  });

  it('surfaces risk factors: blacklist, unverified KYC, IP mismatch, consistency breach, and trading bans', () => {
    const rec = record({
      isBlackListed: true,
      kycVerified: false,
      kycStatusDetail: 'pending re-verification',
      ipMismatch: true,
      kycRiskLabels: ['high_risk_country'],
      consistencyAtRequest: 45,
      consistencyRequired: 30,
      banNewsTrading: true,
      banHFT: true,
      banMTGL: true,
    });

    const { rationale, explanation } = composeDecisionRationale({ record: rec, analysis: null, decision: 'hold' });

    expect(rationale.riskFactors).toEqual(
      expect.arrayContaining([
        'Account is blacklisted',
        'KYC not verified (pending re-verification)',
        'IP mismatch detected against KYC country',
        'KYC risk labels: high_risk_country',
        'Consistency 45.0% exceeds required 30%',
        'Account restricted from news trading',
        'Account restricted from HFT',
        'Account restricted from martingale trading',
      ])
    );
    expect(explanation).toContain('Held pending review');
  });

  it('flags an unsupported rejection when citedRules is empty', () => {
    const rec = record();
    const { rationale } = composeDecisionRationale({ record: rec, analysis: null, decision: 'reject' });
    expect(rationale.decisionBasis).toContain('Rejection is not supported by violation evidence alone — review risk factors above');
  });

  it('mentions rule labels and dollar amounts in the explanation for approve/reject/hold/preapprove', () => {
    const rec = record();
    const analysis = {
      deduction_breakdown: { news: 75 },
      violation_details: { news: [{ trade_id: 't1', explanation: 'news trade', amount: 75 }] },
      total_deductions: 75,
    };

    const approve = composeDecisionRationale({ record: rec, analysis, decision: 'approve' });
    expect(approve.explanation).toContain('News Trading');
    expect(approve.explanation).toMatch(/\$75/);

    const reject = composeDecisionRationale({ record: rec, analysis, decision: 'reject' });
    expect(reject.explanation).toContain('News Trading');

    const preapprove = composeDecisionRationale({ record: rec, analysis, decision: 'preapprove' });
    expect(preapprove.explanation).toContain('Pre-approved pending final risk check');
    expect(preapprove.explanation).toContain('News Trading');
  });

  it('clamps adjustedAmount at 0 when deductions exceed the requested amount', () => {
    const rec = record({ amount: 100, clientAmount: 100, profitSharePercentage: 0 });
    const analysis = {
      deduction_breakdown: { hft: 500 },
      total_deductions: 500,
    };
    const { rationale } = composeDecisionRationale({ record: rec, analysis, decision: 'reject' });
    expect(rationale.math.adjustedAmount).toBe(0);
  });
});
