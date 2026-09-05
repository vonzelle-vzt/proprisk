import { FOREX_ACCOUNTS, type MockAccount } from './dataset.forex';
import { FUTURES_ACCOUNTS } from './dataset.futures';
import type { NetworkCluster, NetworkEdge } from '@/lib/network/types';
import { violationLabel } from '@/lib/violations/labels';

/**
 * Network-intelligence + explainable-decision demo data. Extends the coherent
 * FOREX_ACCOUNTS / FUTURES_ACCOUNTS datasets (dataset.forex.ts / dataset.futures.ts)
 * — every ring/decision/narrative below references real generated mock
 * accounts by array index rather than inventing orphaned ids, so the ring
 * pages, payout pages, and violation pages all stay cross-referenceable.
 *
 * Exports:
 *  - MOCK_NETWORK_CLUSTERS: the 3 investigation rings (copy ring, shared
 *    identity, coordinated payout) as MockNetworkCluster (superset of
 *    NetworkCluster from src/lib/network/types.ts with member/edge/forensic
 *    detail for the ring detail view).
 *  - MOCK_DECISION_HISTORY: ~8 explainable payout decisions with structured
 *    rationale + math, mixing approve/reject/hold.
 *  - MOCK_NARRATIVES: precomputed AI executive narratives keyed by subject
 *    id (ring investigation ids + flagged account ids).
 */

export type MockAssetClass = 'forex' | 'futures';

export interface MockNetworkRingMember {
  accountId: string;
  login: string;
  email: string;
  firstName: string;
  lastName: string;
  country: string;
  provider: string;
  assetClass: MockAssetClass;
  role: string;
  /** Optional per-member forensic signal (not every ring uses every field). */
  recoveryEmail?: string;
  deviceFingerprint?: string;
  ipAddress?: string;
}

export interface MockNetworkCluster extends NetworkCluster {
  members: MockNetworkRingMember[];
  edges: NetworkEdge[];
  sharedIp?: string;
  sharedDevice?: string;
  detectedAt: string;
}

function toMember(a: MockAccount, assetClass: MockAssetClass, role: string): MockNetworkRingMember {
  return {
    accountId: a.accountId,
    login: a.login,
    email: a.email,
    firstName: a.firstName,
    lastName: a.lastName,
    country: a.country,
    provider: a.provider,
    assetClass,
    role,
  };
}

// ---------------------------------------------------------------------------
// Ring A — 4-account forex copy-trading ring
// ---------------------------------------------------------------------------
// Correlated entries, near-identical trade timing, distinct-but-linkable
// emails (same recovery-email domain surfaced during KYC re-verification —
// the primary account emails themselves are unrelated, which is the point:
// the link isn't obvious from the account list alone).

const COPY_RING_INDICES = [2, 9, 16, 23];
const copyRingAccounts = COPY_RING_INDICES.map((i) => FOREX_ACCOUNTS[i]);

const copyRingMembers: MockNetworkRingMember[] = copyRingAccounts.map((a, idx) => ({
  ...toMember(a, 'forex', idx === 0 ? 'leader' : 'follower'),
  recoveryEmail: `${a.lastName.toLowerCase()}.trading.alt@protonmail.com`,
  deviceFingerprint: 'device-fp-9c21a7',
  ipAddress: '187.62.44.19',
}));

const copyRingEdges: NetworkEdge[] = copyRingAccounts.slice(1).map((a, idx) => ({
  source: copyRingAccounts[0].accountId,
  target: a.accountId,
  kind: 'copy_correlation',
  weight: Math.min(0.97, 0.86 + idx * 0.03),
  detail: `${92 + idx}% trade-timing correlation with leader ${copyRingAccounts[0].accountId}, avg entry lag ${(1.4 + idx * 0.6).toFixed(1)}s, lot-size ratio within 4%`,
}));

export const MOCK_COPY_RING: MockNetworkCluster = {
  id: 'RING-COPY-001',
  kind: 'copy_correlation',
  accountIds: copyRingAccounts.map((a) => a.accountId),
  confidence: 0.91,
  severity: 'high',
  summary: `4-account forex copy ring led by account ${copyRingAccounts[0].accountId} (${copyRingAccounts[0].firstName} ${copyRingAccounts[0].lastName}). All three followers mirror the leader's EURUSD/XAUUSD entries within 1-3 seconds at matching lot ratios — consistent with a shared signal source rather than coincidental correlation.`,
  investigationId: 'INV-2026-0031',
  members: copyRingMembers,
  edges: copyRingEdges,
  sharedIp: '187.62.44.19',
  sharedDevice: 'device-fp-9c21a7',
  detectedAt: '2026-06-28T14:12:00Z',
};

// ---------------------------------------------------------------------------
// Ring B — 3-account shared-identity cluster
// ---------------------------------------------------------------------------
// Same email domain (alt contact used on payout KYC forms), similar names,
// same country — classic multi-accounting signal.

const IDENTITY_RING_INDICES = [5, 12, 19];
const identityRingAccounts = IDENTITY_RING_INDICES.map((i) => FOREX_ACCOUNTS[i]);

const identityRingMembers: MockNetworkRingMember[] = identityRingAccounts.map((a) => ({
  ...toMember(a, 'forex', 'linked-identity'),
  recoveryEmail: `${a.firstName.toLowerCase()}${a.lastName.toLowerCase()[0]}.kyc@fastpropmail.net`,
  ipAddress: '41.203.18.204',
}));

const identityRingEdges: NetworkEdge[] = [];
for (let i = 0; i < identityRingAccounts.length; i++) {
  for (let j = i + 1; j < identityRingAccounts.length; j++) {
    identityRingEdges.push({
      source: identityRingAccounts[i].accountId,
      target: identityRingAccounts[j].accountId,
      kind: 'shared_identity',
      weight: 0.83,
      detail: `Shared KYC recovery-email domain (fastpropmail.net) + same country of registration (${identityRingAccounts[i].country})`,
    });
  }
}

export const MOCK_SHARED_IDENTITY_CLUSTER: MockNetworkCluster = {
  id: 'RING-IDENTITY-002',
  kind: 'shared_identity',
  accountIds: identityRingAccounts.map((a) => a.accountId),
  confidence: 0.78,
  severity: 'medium',
  summary: `3 accounts (${identityRingAccounts.map((a) => a.accountId).join(', ')}) registered from ${identityRingAccounts[0].country} share a KYC recovery-email domain (fastpropmail.net) and near-identical name patterns — likely one trader running multiple funded accounts in breach of the one-account policy.`,
  investigationId: 'INV-2026-0034',
  members: identityRingMembers,
  edges: identityRingEdges,
  sharedIp: '41.203.18.204',
  detectedAt: '2026-06-30T09:41:00Z',
};

// ---------------------------------------------------------------------------
// Ring C — 3-account coordinated payout group, forex + futures
// ---------------------------------------------------------------------------
// Payouts submitted within minutes of each other across two different asset
// classes / providers — a signal that is invisible unless you cross the
// forex/futures toggle, which is exactly why this is a moat feature.

const COORD_FOREX_INDICES = [8, 27];
const COORD_FUTURES_INDEX = 4;
const coordForexAccounts = COORD_FOREX_INDICES.map((i) => FOREX_ACCOUNTS[i]);
const coordFuturesAccount = FUTURES_ACCOUNTS[COORD_FUTURES_INDEX];

const coordinatedPayoutMembers: MockNetworkRingMember[] = [
  { ...toMember(coordForexAccounts[0], 'forex', 'payout-submitter'), ipAddress: '102.89.44.7' },
  { ...toMember(coordForexAccounts[1], 'forex', 'payout-submitter'), ipAddress: '102.89.44.11' },
  { ...toMember(coordFuturesAccount, 'futures', 'payout-submitter'), ipAddress: '102.89.44.7' },
];

const coordinatedPayoutEdges: NetworkEdge[] = [
  {
    source: coordForexAccounts[0].accountId,
    target: coordForexAccounts[1].accountId,
    kind: 'coordinated_payout',
    weight: 0.88,
    detail: 'Payout requests submitted 3 minutes apart, both routed to intermediary wallets on the same processor batch',
  },
  {
    source: coordForexAccounts[0].accountId,
    target: coordFuturesAccount.accountId,
    kind: 'coordinated_payout',
    weight: 0.8,
    detail: 'Shared submission IP (102.89.44.7) despite different asset class and provider (forex MatchTrader vs futures book)',
  },
];

export const MOCK_COORDINATED_PAYOUT_CLUSTER: MockNetworkCluster = {
  id: 'RING-PAYOUT-003',
  kind: 'coordinated_payout',
  accountIds: [...coordForexAccounts.map((a) => a.accountId), coordFuturesAccount.accountId],
  confidence: 0.83,
  severity: 'critical',
  summary: `3 payouts (2 forex, 1 futures — accounts ${coordForexAccounts.map((a) => a.accountId).join(', ')}, ${coordFuturesAccount.accountId}) submitted within a 21-minute window from overlapping IPs, spanning two asset classes and providers. Cross-asset coordination like this is invisible on a single-asset dashboard.`,
  investigationId: 'INV-2026-0037',
  members: coordinatedPayoutMembers,
  edges: coordinatedPayoutEdges,
  sharedIp: '102.89.44.7',
  detectedAt: '2026-07-01T03:21:00Z',
};

export const MOCK_NETWORK_CLUSTERS: MockNetworkCluster[] = [
  MOCK_COPY_RING,
  MOCK_SHARED_IDENTITY_CLUSTER,
  MOCK_COORDINATED_PAYOUT_CLUSTER,
];

// ---------------------------------------------------------------------------
// MOCK_DECISION_HISTORY — ~8 explainable payout decisions
// ---------------------------------------------------------------------------

export interface MockDecisionRationaleRule {
  ruleId: string;
  ruleLabel: string;
  deductionAmount: number;
}

export interface MockDecisionMath {
  grossProfit: number;
  totalDeductions: number;
  profitSharePct: number;
  clientShareOfNet: number;
  finalAmount: number;
}

export interface MockPayoutDecision {
  id: string;
  payoutId: string;
  accountId: string;
  assetClass: MockAssetClass;
  decision: 'preapprove' | 'approve' | 'reject' | 'hold';
  actor: string;
  decidedAt: string;
  rationale: {
    citedRules: MockDecisionRationaleRule[];
    math: MockDecisionMath;
  };
  explanation: string;
}

function violatorsOf(list: MockAccount[]): MockAccount[] {
  return list.filter((a) => Object.keys(a.deductionBreakdown).length > 0);
}

function buildRationale(a: MockAccount, profitSharePct = 80): { citedRules: MockDecisionRationaleRule[]; math: MockDecisionMath } {
  const citedRules = Object.entries(a.deductionBreakdown).map(([type, amount]) => ({
    ruleId: type,
    ruleLabel: violationLabel(type),
    deductionAmount: amount,
  }));
  const totalDeductions = citedRules.reduce((s, r) => s + r.deductionAmount, 0);
  const netAfterDeductions = Math.max(0, a.totalPnL - totalDeductions);
  const clientShareOfNet = Math.round(netAfterDeductions * (profitSharePct / 100));
  return {
    citedRules,
    math: {
      grossProfit: a.totalPnL,
      totalDeductions,
      profitSharePct,
      clientShareOfNet,
      finalAmount: clientShareOfNet,
    },
  };
}

function decisionExplanation(a: MockAccount, decision: MockPayoutDecision['decision'], rationale: MockPayoutDecision['rationale']): string {
  const ruleList = rationale.citedRules.map((r) => `${r.ruleLabel} (-$${r.deductionAmount.toLocaleString()})`).join(', ');
  switch (decision) {
    case 'approve':
      return rationale.citedRules.length > 0
        ? `Approved for $${rationale.math.finalAmount.toLocaleString()} after deducting ${ruleList} from $${rationale.math.grossProfit.toLocaleString()} gross profit. Residual profit is defensible trading; no basis to withhold beyond the confirmed breaches.`
        : `Approved for $${rationale.math.finalAmount.toLocaleString()}. No violations detected against $${rationale.math.grossProfit.toLocaleString()} gross profit — clean payout.`;
    case 'reject':
      return `Rejected. ${ruleList} account for ${Math.min(100, Math.round((rationale.math.totalDeductions / Math.max(1, rationale.math.grossProfit)) * 100))}% of gross profit — the trading pattern itself is the violation, not incidental to otherwise-legitimate gains.`;
    case 'hold':
      return `Held pending review. ${ruleList} require manual confirmation against the trade tape before the $${rationale.math.finalAmount.toLocaleString()} residual can be released.`;
    default:
      return `Pre-approved pending final risk check. Provisional deductions: ${ruleList || 'none'}.`;
  }
}

function isoAt(daysAgo: number, hh: number, mm: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hh, mm, 0, 0);
  return d.toISOString();
}

function buildDecisions(): MockPayoutDecision[] {
  const forexViolators = violatorsOf(FOREX_ACCOUNTS).slice(0, 5);
  const futuresViolators = violatorsOf(FUTURES_ACCOUNTS).slice(0, 2);
  const clean = FOREX_ACCOUNTS.find((a) => Object.keys(a.deductionBreakdown).length === 0);

  const pattern: Array<MockPayoutDecision['decision']> = ['approve', 'reject', 'hold', 'approve', 'reject', 'hold', 'approve', 'approve'];
  const pool: Array<{ a: MockAccount; assetClass: MockAssetClass }> = [
    ...forexViolators.map((a) => ({ a, assetClass: 'forex' as const })),
    ...futuresViolators.map((a) => ({ a, assetClass: 'futures' as const })),
    ...(clean ? [{ a: clean, assetClass: 'forex' as const }] : []),
  ].slice(0, 8);

  return pool.map(({ a, assetClass }, i) => {
    const decision = pattern[i % pattern.length];
    const rationale = buildRationale(a);
    return {
      id: `DEC-${a.accountId}`,
      payoutId: `PO-${a.accountId}`,
      accountId: a.accountId,
      assetClass,
      decision,
      actor: i % 2 === 0 ? 'Risk Management System' : 'j.reyes@riskteam.internal',
      decidedAt: isoAt(i + 1, 9 + i, (i * 17) % 60),
      rationale,
      explanation: decisionExplanation(a, decision, rationale),
    };
  });
}

export const MOCK_DECISION_HISTORY: MockPayoutDecision[] = buildDecisions();

// ---------------------------------------------------------------------------
// MOCK_NARRATIVES — precomputed AI executive narratives
// ---------------------------------------------------------------------------

function narrativeForAccount(a: MockAccount, assetClass: MockAssetClass): string {
  const rules = Object.entries(a.deductionBreakdown);
  const total = rules.reduce((s, [, v]) => s + v, 0);
  const primary = rules.sort((x, y) => y[1] - x[1])[0];
  const primaryLabel = primary ? violationLabel(primary[0]) : 'no confirmed';
  const pctOfProfit = a.totalPnL > 0 ? Math.min(100, Math.round((total / a.totalPnL) * 100)) : 0;
  const residual = Math.max(0, a.totalPnL - total);
  const secondary = rules.slice(1).map(([t]) => violationLabel(t));
  const sizeUnit = assetClass === 'futures' ? 'contracts' : 'lots';

  return (
    `Account ${a.accountId} (${a.firstName} ${a.lastName}, ${a.country}) generated $${a.totalPnL.toLocaleString()} in gross profit over ${a.tradedDays} traded days on its $${a.startingBalance.toLocaleString()} ${assetClass} account before enforcement review. ` +
    `The dominant finding is ${primaryLabel.toLowerCase()}, responsible for $${(primary ? primary[1] : 0).toLocaleString()} of the account's activity` +
    (secondary.length > 0 ? `, compounded by ${secondary.join(' and ').toLowerCase()} on the same trade cluster` : '') +
    `. Combined deductions of $${total.toLocaleString()} represent ${pctOfProfit}% of gross profit — a concentration consistent with a deliberate pattern rather than incidental ${sizeUnit} sizing noise. ` +
    `Trade-level evidence (open/close timestamps, symbol, ${sizeUnit}, and P&L per flagged trade) is attached in the evidence pack for this account. ` +
    `Deducting $${total.toLocaleString()} and releasing the residual $${residual.toLocaleString()} is defensible under the platform's violation-detection rules for ${primaryLabel.toLowerCase()}; the residual reflects trading activity untouched by any confirmed breach. Recommend proceeding on that basis unless the account disputes the trade tape.`
  );
}

function buildAccountNarratives(): Record<string, string> {
  const forexFlagged = violatorsOf(FOREX_ACCOUNTS).slice(0, 2);
  const futuresFlagged = violatorsOf(FUTURES_ACCOUNTS).slice(0, 2);
  const out: Record<string, string> = {};
  for (const a of forexFlagged) out[a.accountId] = narrativeForAccount(a, 'forex');
  for (const a of futuresFlagged) out[a.accountId] = narrativeForAccount(a, 'futures');
  return out;
}

export const MOCK_NARRATIVES: Record<string, string> = {
  ...buildAccountNarratives(),
  'RING-COPY-001': `Accounts ${MOCK_COPY_RING.accountIds.join(', ')} form a 4-node copy-trading ring anchored on leader account ${copyRingAccounts[0].accountId} (${copyRingAccounts[0].firstName} ${copyRingAccounts[0].lastName}, ${copyRingAccounts[0].country}). Every follower entry on EURUSD and XAUUSD lands within 1-3 seconds of the leader's fill at matching lot ratios (within 4%), a correlation window too tight for independent discretionary trading. All three followers also share a KYC recovery-email domain and a device fingerprint (device-fp-9c21a7) traced to a single IP (187.62.44.19), which rules out coincidental strategy overlap — this is one operator distributing risk across four funded accounts to multiply payouts from a single edge. Recommend freezing pending payouts on all four accounts, consolidating the profit-share calculation as a single beneficial owner under the one-account policy, and referring to the fraud desk for KYC re-verification before any further payout is released. The leader account should be actioned first; followers are downstream of the same signal.`,
  'RING-IDENTITY-002': `Accounts ${MOCK_SHARED_IDENTITY_CLUSTER.accountIds.join(', ')}, all registered from ${identityRingAccounts[0].country}, share a KYC recovery-email domain (fastpropmail.net) and closely patterned names, a combination the shared-identity detector flags at 78% confidence. Individually, each account's trading and violation history looks unremarkable — the risk is not in any single account's behavior but in one trader controlling three funded slots in breach of the platform's one-account-per-trader policy, which triples the effective payout exposure on a single strategy. No coordinated-payout or copy-correlation signal was found alongside this cluster, so the recommended action is identity re-verification (govt ID cross-check) rather than an immediate payout hold. If re-verification confirms common ownership, consolidate to a single account and apply the standard multi-accounting penalty to the other two.`,
  'RING-PAYOUT-003': `Three payout requests — accounts ${coordForexAccounts[0].accountId} and ${coordForexAccounts[1].accountId} (forex) and ${coordFuturesAccount.accountId} (futures) — were submitted within a 21-minute window on 2026-07-01, two of them from the identical IP (102.89.44.7) despite spanning different asset classes, providers, and (on paper) unrelated traders. This pattern is invisible on a single-asset dashboard: nothing about any one payout is anomalous in isolation, and the futures/forex segmentation actively hides the correlation from a reviewer who only ever looks at one book. Confidence is 83%, driven primarily by the IP overlap rather than trading-pattern similarity. Recommend holding all three payouts pending a joint IP/device review across both asset classes, and escalate to fraud hunter for a cross-asset investigation regardless of the outcome on any individual account's risk check.`,
};
