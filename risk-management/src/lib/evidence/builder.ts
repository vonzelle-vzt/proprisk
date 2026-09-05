import { DEMO_MODE, type AssetClass } from '@/lib/demo';
import { FOREX_ACCOUNTS, type MockAccount } from '@/lib/mock/dataset.forex';
import { FUTURES_ACCOUNTS } from '@/lib/mock/dataset.futures';
import {
  MOCK_NETWORK_CLUSTERS,
  MOCK_DECISION_HISTORY,
  MOCK_NARRATIVES,
  type MockNetworkCluster,
} from '@/lib/mock/dataset.network';
import { buildAnalyzeResult } from '@/lib/mock/builders';
import { violationLabel } from '@/lib/violations/labels';
import { askClaude, CLAUDE_MODELS } from '@/lib/ai/claude';
import { createAdminClient } from '@/lib/supabase/admin';
import type {
  EvidencePack,
  EvidencePackSections,
  EvidenceSubjectType,
  RuleFinding,
  TradeEvidenceRow,
  EvidenceNetworkLink,
  EvidenceAuditEntry,
  EvidenceDecisionHistoryEntry,
  EvidenceDeductionMathLine,
} from './types';

/**
 * Assembles the full evidence-pack dossier for a subject (payout / violation /
 * account / investigation), demo or live.
 *
 * DEMO_MODE: built entirely from the coherent mock datasets — never touches
 * Supabase or Claude. LIVE: assembled from Supabase tables + the platform
 * facade, persisted to `evidence_packs`, with an AI-written narrative
 * (`askClaude`) that falls back to a deterministic factual summary on any
 * failure so a pack is never blocked on the model call.
 */

export interface BuildEvidencePackInput {
  subjectType: EvidenceSubjectType;
  subjectId: string;
  accountId?: string | null;
  assetClass?: AssetClass;
  /**
   * Required for live-mode persistence. `evidence_packs.tenant_id` is
   * NOT NULL under the tenancy migration (supabase/migrations/00015), and
   * every lookup below (accounts, violations) is filtered by it too — without
   * it, buildLivePack() would either throw on insert or, worse, resolve
   * `accountKey` against another tenant's account. Demo mode ignores this.
   */
  tenantId?: string;
}

const SUBJECT_LABEL: Record<EvidenceSubjectType, string> = {
  payout: 'Payout',
  violation: 'Violation',
  account: 'Account Review',
  investigation: 'Investigation',
};

// ---------------------------------------------------------------------------
// Demo-id encoding — GET /api/evidence/[id] rebuilds the pack from this id
// rather than persisting anything. subjectId may itself contain hyphens
// (e.g. "100074-hft"), so decoding only splits on the first two segments
// (the "demo" tag and the known subjectType), and treats the remainder —
// however many hyphens it contains — as the full subjectId.
// ---------------------------------------------------------------------------

const SUBJECT_TYPES: EvidenceSubjectType[] = ['payout', 'violation', 'account', 'investigation'];

export function encodeDemoEvidenceId(subjectType: EvidenceSubjectType, subjectId: string): string {
  return `demo-${subjectType}-${subjectId}`;
}

export function decodeDemoEvidenceId(id: string): { subjectType: EvidenceSubjectType; subjectId: string } | null {
  if (!id.startsWith('demo-')) return null;
  const rest = id.slice('demo-'.length);
  for (const st of SUBJECT_TYPES) {
    if (rest.startsWith(`${st}-`)) {
      return { subjectType: st, subjectId: rest.slice(st.length + 1) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule descriptions — human-readable threshold/observed text per violation
// type, matched to the actual engine logic in
// src/lib/payouts/detailed-risk-analysis.ts and src/lib/risk/futures/*.
// ---------------------------------------------------------------------------

const RULE_DESCRIPTIONS: Record<string, { threshold: string; observed: (a: MockAccount, ev: TradeEvidenceRow[]) => string }> = {
  hft: {
    threshold: 'Max 6 positions opened within any rolling 60s window (scaled thresholds down to 2 in 3s)',
    observed: (_a, ev) => `${ev.length} flagged trade(s) opened in rapid succession within the rolling window`,
  },
  martingale: {
    threshold: 'Lot size may not increase >1.5x the prior trade after 2+ consecutive losses',
    observed: (_a, ev) => `Lot-size escalation confirmed on ${ev.length} trade(s) following consecutive losses`,
  },
  overleveraging: {
    threshold: 'Concurrent lot exposure per symbol must stay within the plan lot-size limit',
    observed: (_a, ev) => `Concurrent exposure exceeded the plan limit on ${ev.length} trade(s)`,
  },
  grid: {
    threshold: 'No regular-interval grid pattern on a single symbol (≥5 trades, ≥60% regular spacing)',
    observed: (_a, ev) => `Regular-interval spacing confirmed across ${ev.length} trade(s) on the same symbol`,
  },
  news: {
    threshold: 'No trade open/close within 5 minutes of a high-impact news release on a correlated currency',
    observed: (_a, ev) => `${ev.length} trade(s) opened or closed inside the news blackout window`,
  },
  copy: {
    threshold: 'No correlated trade-timing / lot-ratio match with another funded account',
    observed: (_a, ev) => `${ev.length} correlated trade(s) matched to a linked account within the tolerance window`,
  },
  overnight: {
    threshold: 'Positions must be flattened before the platform daily rollover',
    observed: (_a, ev) => `${ev.length} position(s) held open through daily rollover`,
  },
  daily_loss: {
    threshold: 'Daily loss must stay within the plan daily-loss limit',
    observed: () => 'Daily loss limit breached, account locked from further trading',
  },
  trailing_drawdown: {
    threshold: 'Trailing drawdown must stay within the plan trailing-drawdown limit',
    observed: () => 'Trailing drawdown limit breached, account locked from further trading',
  },
  position_limit: {
    threshold: 'Open position size must stay within the plan contract limit',
    observed: () => 'Position size limit exceeded',
  },
  eod_flat: {
    threshold: 'All positions must be flat at the end-of-day cutoff',
    observed: () => 'Open position(s) found at the end-of-day cutoff',
  },
};

function ruleDescription(type: string): { threshold: string; observed: (a: MockAccount, ev: TradeEvidenceRow[]) => string } {
  return RULE_DESCRIPTIONS[type] ?? { threshold: 'Platform policy limit', observed: () => 'Threshold exceeded' };
}

// ---------------------------------------------------------------------------
// Demo-mode assembly
// ---------------------------------------------------------------------------

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function buildAccountSummary(a: MockAccount, assetClass: AssetClass): Record<string, unknown> {
  return {
    accountId: a.accountId,
    login: a.login,
    firstName: a.firstName,
    lastName: a.lastName,
    email: a.email,
    country: a.country,
    provider: a.provider,
    assetClass,
    kycStatus: a.kycStatus,
    isBlackListed: a.isBlackListed,
    plan: a.plan,
    startingBalance: a.startingBalance,
    balance: a.balance,
    totalPnL: a.totalPnL,
    tradedDays: a.tradedDays,
    canTrade: a.canTrade ?? true,
  };
}

function buildScoringTrail(account: MockAccount, analyze: any): RuleFinding[] {
  const vtypes = Object.keys(account.deductionBreakdown).filter((t) => account.deductionBreakdown[t] > 0);
  const tradesById = new Map<string, any>((analyze.trades || []).map((t: any) => [t._id, t]));

  return vtypes.map((type) => {
    const details: Array<{ trade_id: string; explanation: string; amount: number }> = analyze.violation_details?.[type] || [];
    const evidence: TradeEvidenceRow[] = details.map((d) => {
      const trade = tradesById.get(d.trade_id);
      return {
        tradeId: d.trade_id,
        symbol: trade?.trdSymbol ?? '—',
        openTime: trade?.openTime ?? '',
        closeTime: trade?.closeTime ?? '',
        lots: trade?.lots ?? 0,
        profit: trade?.profit ?? 0,
        note: d.explanation,
      };
    });
    const desc = ruleDescription(type);
    return {
      ruleId: type,
      ruleLabel: violationLabel(type),
      threshold: desc.threshold,
      observed: desc.observed(account, evidence),
      verdict: 'breach',
      evidence,
      deductionAmount: account.deductionBreakdown[type],
    };
  });
}

function buildDeductionMath(account: MockAccount, vtypes: string[], profitSharePct = 80): EvidenceDeductionMathLine[] {
  const lines: EvidenceDeductionMathLine[] = [{ label: 'Gross profit', amount: account.totalPnL }];
  let totalDeductions = 0;
  for (const t of vtypes) {
    const amount = account.deductionBreakdown[t];
    totalDeductions += amount;
    lines.push({ label: `${violationLabel(t)} deduction`, amount: -amount, note: `Rule: ${t}` });
  }
  const netAfterDeductions = Math.max(0, account.totalPnL - totalDeductions);
  lines.push({ label: 'Net profit after deductions', amount: netAfterDeductions });
  const clientShare = Math.round(netAfterDeductions * (profitSharePct / 100));
  lines.push({ label: `Client share (${profitSharePct}%)`, amount: clientShare, note: 'Final payout amount' });
  return lines;
}

function buildDemoAuditEntries(
  account: MockAccount,
  vtypes: string[],
  decisions: (typeof MOCK_DECISION_HISTORY)[number][]
): EvidenceAuditEntry[] {
  const entries: EvidenceAuditEntry[] = vtypes.map((t, i) => ({
    actionType: 'violation_detected',
    performedBy: 'Risk Management System',
    occurredAt: isoDaysAgo(vtypes.length - i + 2),
    detail: `${violationLabel(t)} detected on account ${account.accountId} — deduction $${account.deductionBreakdown[t].toLocaleString()}`,
  }));
  for (const d of decisions) {
    entries.push({
      actionType: 'payout_decision',
      performedBy: d.actor,
      occurredAt: d.decidedAt,
      detail: `Payout ${d.decision} — ${d.explanation}`,
    });
  }
  return entries.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
}

function buildNetworkLinks(accountId: string, clusters: MockNetworkCluster[]): EvidenceNetworkLink[] {
  const links: EvidenceNetworkLink[] = [];
  for (const c of clusters) {
    if (!c.accountIds.includes(accountId)) continue;
    for (const e of c.edges) {
      if (e.source !== accountId && e.target !== accountId) continue;
      const other = e.source === accountId ? e.target : e.source;
      links.push({ accountId: other, kind: e.kind, detail: e.detail, weight: e.weight });
    }
  }
  return links;
}

function buildTitle(subjectType: EvidenceSubjectType, account: MockAccount, cluster?: MockNetworkCluster): string {
  if (subjectType === 'investigation' && cluster) {
    return `Evidence Pack — ${SUBJECT_LABEL.investigation} ${cluster.investigationId} (${cluster.kind.replace(/_/g, ' ')})`;
  }
  return `Evidence Pack — ${SUBJECT_LABEL[subjectType]} · Account ${account.accountId} (${account.firstName} ${account.lastName})`;
}

function buildDemoPack(input: BuildEvidencePackInput): EvidencePack {
  const allAccounts = [...FOREX_ACCOUNTS, ...FUTURES_ACCOUNTS];

  let cluster: MockNetworkCluster | undefined;
  if (input.subjectType === 'investigation') {
    cluster = MOCK_NETWORK_CLUSTERS.find((c) => c.id === input.subjectId || c.investigationId === input.subjectId);
  }

  const lookupId = input.accountId || (cluster ? cluster.accountIds[0] : input.subjectId);
  const account =
    allAccounts.find((a) => a.accountId === lookupId || a.login === lookupId) ||
    allAccounts.find((a) => Object.keys(a.deductionBreakdown).length > 0) ||
    allAccounts[0];

  const resolvedAssetClass: AssetClass = FUTURES_ACCOUNTS.includes(account) ? 'futures' : 'forex';
  const analyze = buildAnalyzeResult(resolvedAssetClass, account.accountId).data;
  const vtypes = Object.keys(account.deductionBreakdown).filter((t) => account.deductionBreakdown[t] > 0);
  const accountDecisions = MOCK_DECISION_HISTORY.filter((d) => d.accountId === account.accountId);

  const sections: EvidencePackSections = {
    accountSummary: buildAccountSummary(account, resolvedAssetClass),
    scoringTrail: buildScoringTrail(account, analyze),
    deductionMath: buildDeductionMath(account, vtypes),
    newsEvents: (analyze.news_events || []) as EvidencePackSections['newsEvents'],
    networkLinks: cluster
      ? buildNetworkLinks(account.accountId, [cluster])
      : buildNetworkLinks(account.accountId, MOCK_NETWORK_CLUSTERS),
    auditEntries: buildDemoAuditEntries(account, vtypes, accountDecisions),
    decisionHistory: accountDecisions.map((d) => ({
      decisionId: d.id,
      decision: d.decision,
      actor: d.actor,
      decidedAt: d.decidedAt,
      summary: d.explanation,
    })),
  };

  const pack: EvidencePack = {
    id: encodeDemoEvidenceId(input.subjectType, input.subjectId),
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    accountId: account.accountId,
    assetClass: resolvedAssetClass,
    title: buildTitle(input.subjectType, account, cluster),
    createdAt: new Date().toISOString(),
    createdBy: null,
    narrative: null,
    sections,
  };

  const narrativeKey = cluster?.id ?? input.subjectId;
  pack.narrative = MOCK_NARRATIVES[narrativeKey] ?? MOCK_NARRATIVES[account.accountId] ?? composeFallbackNarrative(pack);
  return pack;
}

// ---------------------------------------------------------------------------
// Deterministic narrative fallback — used in demo when no precomputed
// narrative matches, and in live mode whenever askClaude throws/errors.
// ---------------------------------------------------------------------------

function composeFallbackNarrative(pack: EvidencePack): string {
  const s = pack.sections;
  const totalDeductions = s.deductionMath
    .filter((l) => l.amount < 0)
    .reduce((sum, l) => sum + Math.abs(l.amount), 0);
  const ruleNames = s.scoringTrail.map((r) => r.ruleLabel);
  const tradeCount = s.scoringTrail.reduce((n, r) => n + r.evidence.length, 0);

  const parts: string[] = [];
  parts.push(
    ruleNames.length > 0
      ? `${ruleNames.length} confirmed rule finding(s) — ${ruleNames.join(', ')} — cite ${tradeCount} flagged trade(s) and total $${totalDeductions.toLocaleString()} in deductions.`
      : 'No confirmed rule breaches were found against this subject.'
  );
  if (s.networkLinks.length > 0) {
    parts.push(`${s.networkLinks.length} network linkage(s) to related account(s) were identified.`);
  }
  if (s.decisionHistory.length > 0) {
    parts.push(`${s.decisionHistory.length} prior decision(s) are on record for this subject.`);
  }
  parts.push('This summary was generated deterministically from the platform rule-engine output; no narrative-generation model was consulted.');
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Live-mode assembly
// ---------------------------------------------------------------------------

const NARRATIVE_SYSTEM_PROMPT =
  'You are a senior prop-firm risk analyst writing the executive narrative for an evidence pack that will be read by compliance, the trader, and potentially a dispute reviewer months later. Be strictly factual and defensibility-focused: cite specific trades, rules, and dollar amounts from the material provided. Do not speculate beyond the evidence given. Write 120-180 words of plain prose — no headers, no bullet points.';

function buildNarrativePrompt(pack: EvidencePack): string {
  return [
    `Title: ${pack.title}`,
    `Subject: ${pack.subjectType} ${pack.subjectId}`,
    `Rule findings: ${JSON.stringify(
      pack.sections.scoringTrail.map((r) => ({
        rule: r.ruleLabel,
        threshold: r.threshold,
        observed: r.observed,
        deduction: r.deductionAmount,
        tradeCount: r.evidence.length,
      }))
    )}`,
    `Deduction math: ${JSON.stringify(pack.sections.deductionMath)}`,
    `Network links: ${JSON.stringify(pack.sections.networkLinks)}`,
    `Decision history: ${JSON.stringify(pack.sections.decisionHistory)}`,
    'Write the executive narrative now.',
  ].join('\n');
}

/**
 * One `violations` row -> one `RuleFinding`, live mode.
 *
 * Two shapes of `details_json` reach here (src/lib/violations/record.ts is
 * the source of truth): `source: 'rule_pack'` rows carry the evaluator's own
 * `BreachEvidence` (limit/observed/math/tradeIds, see
 * src/lib/rulepack/types.ts) verbatim, and that is what gets shown — the old
 * generic `ruleDescription()` text was a placeholder for detectors that never
 * wrote a real limit/observed pair. Legacy rows (`source: 'legacy_engine'` or
 * absent) keep going through `ruleDescription()` exactly as before, and a
 * rule-pack row that is somehow missing `evidence` falls back to the same
 * legacy path rather than throwing.
 */
function buildLiveRuleFinding(v: any, accountRow: any, tradesById: Map<string, any>): RuleFinding {
  const details = (v.details_json || {}) as Record<string, any>;
  const rpEvidence = details.source === 'rule_pack' ? details.evidence : undefined;

  if (rpEvidence && typeof rpEvidence.limit === 'string' && typeof rpEvidence.observed === 'string') {
    const ruleId: string = details.rule_id || v.violation_type;
    const tradeIdList: string[] = Array.isArray(rpEvidence.tradeIds) ? rpEvidence.tradeIds : [];
    const matchedIds = tradeIdList.filter((id) => tradesById.has(id));
    const idsForEvidence = matchedIds.length > 0 ? matchedIds : v.related_trade_ids || [];
    const evidence: TradeEvidenceRow[] = idsForEvidence
      .map((id: string) => tradesById.get(id))
      .filter(Boolean)
      .map((t: any) => ({
        tradeId: t.id,
        symbol: t.symbol,
        openTime: t.open_time,
        closeTime: t.close_time ?? '',
        lots: t.lot_size,
        profit: t.profit,
      }));
    const finding: RuleFinding = {
      ruleId,
      ruleLabel: violationLabel(ruleId),
      threshold: rpEvidence.limit,
      observed: rpEvidence.observed,
      verdict: 'breach',
      evidence,
      deductionAmount: v.deduction_amount ?? 0,
    };
    if (typeof rpEvidence.math === 'string' && rpEvidence.math.length > 0) {
      finding.math = rpEvidence.math;
    }
    return finding;
  }

  // Legacy path — unchanged, and also the fallback for a rule-pack row
  // recorded without its `evidence` (should not happen post-record.ts, but a
  // missing/malformed field here must degrade to a generic finding, not throw).
  const evidence: TradeEvidenceRow[] = (v.related_trade_ids || [])
    .map((id: string) => tradesById.get(id))
    .filter(Boolean)
    .map((t: any) => ({
      tradeId: t.id,
      symbol: t.symbol,
      openTime: t.open_time,
      closeTime: t.close_time ?? '',
      lots: t.lot_size,
      profit: t.profit,
    }));
  const desc = ruleDescription(v.violation_type);
  return {
    ruleId: v.violation_type,
    ruleLabel: violationLabel(v.violation_type),
    threshold: desc.threshold,
    observed: desc.observed(accountRow, evidence),
    verdict: 'breach',
    evidence,
    deductionAmount: v.deduction_amount ?? 0,
  };
}

async function buildLivePack(input: BuildEvidencePackInput): Promise<EvidencePack> {
  const supabase = createAdminClient();

  const accountKey = input.accountId || input.subjectId;
  // accountKey is user-supplied; never interpolate it into a PostgREST `.or()`
  // filter string (filter-injection vector). Sanitize to a strict identifier
  // charset, then look it up with two parameterized `.eq()` queries.
  let accountRow: any = null;
  if (accountKey && /^[A-Za-z0-9_-]+$/.test(accountKey)) {
    let byId = supabase.from('accounts').select('*').eq('id', accountKey);
    if (input.tenantId) byId = byId.eq('tenant_id', input.tenantId);
    accountRow = (await byId.maybeSingle()).data ?? null;
    if (!accountRow) {
      let byLogin = supabase.from('accounts').select('*').eq('login', accountKey);
      if (input.tenantId) byLogin = byLogin.eq('tenant_id', input.tenantId);
      accountRow = (await byLogin.maybeSingle()).data ?? null;
    }
  }

  let violationRows: any[] = [];
  if (input.subjectType === 'violation') {
    let q = supabase.from('violations').select('*').eq('id', input.subjectId);
    if (input.tenantId) q = q.eq('tenant_id', input.tenantId);
    const { data } = await q;
    violationRows = data || [];
  } else if (accountRow) {
    let q = supabase.from('violations').select('*').eq('account_id', accountRow.id);
    if (input.tenantId) q = q.eq('tenant_id', input.tenantId);
    const { data } = await q;
    violationRows = data || [];
  }

  const tradeIds = Array.from(new Set(violationRows.flatMap((v) => v.related_trade_ids || [])));
  const { data: tradeRows } = tradeIds.length
    ? await supabase.from('trades').select('*').in('id', tradeIds)
    : { data: [] as any[] };
  const tradesById = new Map<string, any>((tradeRows || []).map((t: any) => [t.id, t]));

  const { data: deductionRows } = accountRow
    ? await supabase.from('deductions').select('*').eq('account_id', accountRow.id).order('executed_at', { ascending: false })
    : { data: [] as any[] };

  const { data: decisionRows } = accountRow
    ? await supabase.from('payout_decisions').select('*').eq('account_id', accountRow.id).order('created_at', { ascending: false })
    : { data: [] as any[] };

  const { data: auditRows } = accountRow
    ? await supabase.from('audit_log').select('*').eq('entity_id', accountRow.id).order('created_at', { ascending: false }).limit(25)
    : { data: [] as any[] };

  const scoringTrail: RuleFinding[] = violationRows.map((v) => buildLiveRuleFinding(v, accountRow, tradesById));

  // Rule-pack provenance for the pack as a whole — taken from the first
  // rule-pack-sourced violation row, since a `violation` subject is exactly
  // one row and an `account` subject's rows all come from the same tenant
  // pack in practice. Absent for legacy-only subjects.
  const rulePackRow = violationRows.find((v) => (v.details_json || {}).source === 'rule_pack');
  const rulePackDetails = rulePackRow ? (rulePackRow.details_json as Record<string, any>) : null;
  const rulePack: EvidencePackSections['rulePack'] = rulePackDetails
    ? {
        id: rulePackDetails.rule_pack_id,
        version: rulePackDetails.rule_pack_version,
        contentHash: rulePackDetails.rule_pack_content_hash,
      }
    : undefined;

  const deductionMath: EvidenceDeductionMathLine[] = (deductionRows || []).length
    ? [
        { label: 'Gross profit', amount: accountRow?.total_pnl ?? 0 },
        ...(deductionRows || []).map((d: any) => ({
          label: d.reason || 'Deduction',
          amount: -Math.abs(d.amount),
          note: d.executed_by,
        })),
      ]
    : scoringTrail.map((r) => ({ label: `${r.ruleLabel} deduction`, amount: -r.deductionAmount }));

  const networkLinks: EvidenceNetworkLink[] = [];
  for (const v of violationRows) {
    if (v.violation_type !== 'grid' && v.violation_type !== 'copy') continue;
    const details = (v.details_json || {}) as Record<string, any>;
    const otherId = details.account_b_id || details.follower_account_id || details.account_a_id || details.leader_account_id;
    if (otherId) {
      networkLinks.push({
        accountId: otherId,
        kind: v.violation_type === 'copy' ? 'copy_correlation' : 'grid_correlation',
        detail: `${violationLabel(v.violation_type)} pattern linked to account ${otherId}`,
        weight: 0.8,
      });
    }
  }

  const auditEntries: EvidenceAuditEntry[] = (auditRows || []).map((r: any) => ({
    actionType: r.action_type,
    performedBy: r.performed_by,
    occurredAt: r.created_at,
    detail: JSON.stringify(r.details_json ?? {}),
  }));

  const decisionHistory: EvidenceDecisionHistoryEntry[] = (decisionRows || []).map((d: any) => ({
    decisionId: d.id,
    decision: d.decision,
    actor: d.actor,
    decidedAt: d.created_at,
    summary: d.explanation || '',
  }));

  const assetClass = input.assetClass ?? null;
  const title = accountRow
    ? `Evidence Pack — ${SUBJECT_LABEL[input.subjectType]} · Account ${accountRow.login ?? accountRow.id}`
    : `Evidence Pack — ${SUBJECT_LABEL[input.subjectType]} ${input.subjectId}`;

  const sections: EvidencePackSections = {
    accountSummary: accountRow ?? {},
    scoringTrail,
    deductionMath,
    newsEvents: [],
    networkLinks,
    auditEntries,
    decisionHistory,
    ...(rulePack ? { rulePack } : {}),
  };

  const draftPack: EvidencePack = {
    id: '',
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    accountId: accountRow?.id ?? input.accountId ?? null,
    assetClass,
    title,
    createdAt: new Date().toISOString(),
    createdBy: null,
    narrative: null,
    sections,
  };

  let narrative: string;
  try {
    narrative = await askClaude({
      model: CLAUDE_MODELS.narrative,
      system: NARRATIVE_SYSTEM_PROMPT,
      prompt: buildNarrativePrompt(draftPack),
      maxTokens: 400,
    });
  } catch {
    narrative = composeFallbackNarrative(draftPack);
  }

  const { data: inserted, error } = await supabase
    .from('evidence_packs')
    .insert({
      // tenant_id is NOT NULL (supabase/migrations/00015_tenancy.sql) — a
      // caller that omits it gets the same DB error today it always would
      // have; this is not a new failure mode, just naming it instead of
      // leaving it to surface as an opaque insert error.
      tenant_id: input.tenantId ?? accountRow?.tenant_id,
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      account_id: draftPack.accountId,
      asset_class: assetClass,
      title,
      pack: sections,
      narrative,
      created_by: null,
    })
    .select('id, created_at')
    .single();

  if (error || !inserted) {
    throw new Error(`Failed to persist evidence pack: ${error?.message ?? 'unknown error'}`);
  }

  return { ...draftPack, id: inserted.id, createdAt: inserted.created_at, narrative };
}

export async function buildEvidencePack(input: BuildEvidencePackInput): Promise<EvidencePack> {
  return DEMO_MODE ? buildDemoPack(input) : buildLivePack(input);
}
