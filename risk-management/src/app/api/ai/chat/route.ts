import { NextRequest, NextResponse } from 'next/server';
import { DEMO_MODE } from '@/lib/demo';
import { parseIntent, classifyIntentWithLLM } from '@/lib/ai/intent-parser';
import { computeRiskScore, detectAnomalies } from '@/lib/ai/analytics';
import {
  formatHelpResponse,
  formatUnknownResponse,
  formatPendingPayoutsResponse,
  formatAccountLookupResponse,
  formatViolationsSummaryResponse,
  formatHighRiskResponse,
  formatSecurityCheckResponse,
  formatRiskScoreResponse,
  formatAccountTradesResponse,
  formatAccountViolationsResponse,
  formatDeductionHistoryResponse,
  formatMorningReportResponse,
  formatFraudScanResponse,
  formatFraudReportResponse,
  formatEnforcementQueueResponse,
  formatEnforcementSummaryResponse,
  formatRepeatOffendersResponse,
} from '@/lib/ai/response-formatter';
import { runFraudHunterScan } from '@/lib/fraud-hunter/agent';
import { getFraudInvestigations } from '@/lib/fraud-hunter/persistence';
import { getEnforcementQueue, getQueueSummary } from '@/lib/enforcement/queue-manager';
import {
  fetchPendingPayouts,
  fetchAccountDetails,
  fetchUserDetails,
  fetchAccountMetrics,
  fetchAccountTradeData,
  fetchLedgerEvents,
} from '@/lib/platform/client';
import { enrichPayouts } from '@/lib/payouts/enrich';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import type { PayoutRecord } from '@/types/payouts';
import type { BotResponse, AnomalyFlag } from '@/types/ai';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CONCURRENCY = 5;

export async function POST(request: NextRequest) {
  if (DEMO_MODE) {
    const body = await request.json().catch(() => ({ message: '' }));
    const msg = String(body?.message || '').trim();
    const response = msg
      ? `**Demo response** — _"${msg}"_\n\nAcross your connected platforms I can see **58 accounts** (Forex + Futures). Highlights:\n\n- **24** accounts flagged for risk violations\n- Top types: Overleveraging, Trailing Drawdown, HFT\n- **$18,400** in pending deductions\n- 3 futures accounts hit their daily-loss limit today\n\n_This is sample data in demo mode — connect a live trading platform to analyze real accounts._`
      : formatHelpResponse();
    return NextResponse.json({ response, intent: 'general_question' });
  }
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const rl = await checkRateLimit(`ai-chat:${ip}`, { windowMs: 60_000, maxRequests: 10 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const body = await request.json();
    const message = body.message?.trim();

    if (!message) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    const parsed = parseIntent(message);
    let intent = parsed.intent;
    let params = parsed.params;
    let classifier: 'regex' | 'llm' = 'regex';

    // Regex fast-path was low-confidence ('unknown', or a catch-all
    // 'general_question' match) — try the Claude classifier in live mode.
    // Any failure (including demo mode / missing key, which askClaudeJSON
    // throws for) falls straight back to the regex result.
    if (parsed.lowConfidence && !DEMO_MODE && process.env.ANTHROPIC_API_KEY) {
      try {
        const llmResult = await classifyIntentWithLLM(message);
        intent = llmResult.intent;
        params = llmResult.params;
        classifier = 'llm';
      } catch {
        // fall back to the regex result already assigned above
      }
    }

    let response: string;

    switch (intent) {
      case 'help':
        response = formatHelpResponse();
        break;

      case 'pending_payouts':
        response = await handlePendingPayouts(auth.tenantId);
        break;

      case 'account_lookup':
        response = await handleAccountLookup(params.accountId, auth.tenantId);
        break;

      case 'violations_summary':
        response = await handleViolationsSummary(auth.tenantId);
        break;

      case 'high_risk':
        response = await handleHighRisk(auth.tenantId);
        break;

      case 'security_check':
        response = await handleSecurityCheck(auth.tenantId);
        break;

      case 'risk_score':
        response = await handleRiskScore(params.accountId, auth.tenantId);
        break;

      case 'account_trades':
        response = await handleAccountTrades(params.accountId, auth.tenantId);
        break;

      case 'account_violations':
        response = await handleAccountViolations(params.accountId, auth.tenantId);
        break;

      case 'deduction_history':
        response = await handleDeductionHistory(auth.tenantId);
        break;

      case 'morning_report':
        response = await handleMorningReport(auth.tenantId);
        break;

      case 'fraud_hunt':
        response = await handleFraudHunt(auth.tenantId);
        break;

      case 'fraud_report':
        response = await handleFraudReport(auth.tenantId);
        break;

      case 'enforcement_queue':
        response = await handleEnforcementQueue();
        break;

      case 'enforcement_summary':
        response = await handleEnforcementSummary();
        break;

      case 'repeat_offenders':
        response = await handleRepeatOffenders();
        break;

      case 'general_question':
        response = await handleGeneralQuestion(message, auth.tenantId);
        break;

      default:
        response = formatUnknownResponse(message);
    }

    const result: BotResponse = { response, intent, classifier };
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('AI Chat error:', error);
    return NextResponse.json(
      { error: 'Failed to process request' },
      { status: 500 }
    );
  }
}

// --- Intent Handlers ---

async function handlePendingPayouts(tenantId: string): Promise<string> {
  const payouts = await fetchPendingPayouts({
    statuses: ['Pending'],
    limit: 1000,
  }, tenantId);

  // Build minimal PayoutRecords for enrichment
  const records: PayoutRecord[] = payouts.map((p) => ({
    id: p._id,
    _id: p._id,
    accountId: p.accountId.toString(),
    userId: p.userId,
    email: p.email,
    orderNumber: p.orderId?.toString() || '',
    amount: p.amount,
    clientAmount: p.clientPayout,
    fee: p.fee,
    plan: p.plan,
    country: p.country,
    kycStatus: 'Unknown',
    ipMismatch: false,
    platformViolations: [],
    notes: '',
    status: 'Pending',
  }));

  const enriched = await enrichPayouts(records, tenantId);
  return formatPendingPayoutsResponse(enriched);
}

async function handleAccountLookup(accountId: string | undefined, tenantId: string): Promise<string> {
  if (!accountId) {
    return '## Account Lookup\n\nPlease provide an account ID. Example: **"account 12345"**';
  }

  const [account, metrics] = await Promise.all([
    fetchAccountDetails(accountId, tenantId),
    fetchAccountMetrics(accountId, tenantId),
  ]);

  const userId = account?.userId;
  const user = userId ? await fetchUserDetails(userId, tenantId) : null;

  const riskScore = computeRiskScore({
    deductions: metrics.deductions,
    account,
    user,
  });

  const anomalies = detectAnomalies({
    accountId,
    deductions: metrics.deductions,
    account,
    user,
  });

  return formatAccountLookupResponse(accountId, account, user, metrics.deductions, riskScore, anomalies);
}

async function handleViolationsSummary(tenantId: string): Promise<string> {
  const payouts = await fetchPendingPayouts({
    statuses: ['Pending'],
    limit: 1000,
  }, tenantId);

  // Deduplicate
  const unique = new Map<string, (typeof payouts)[0]>();
  for (const p of payouts) {
    if (p.accountId && !unique.has(p.accountId)) unique.set(p.accountId, p);
  }

  const accounts: {
    accountId: string;
    login: string;
    totalDeductions: number;
    violationTypes: string[];
    breakdownByType: Record<string, number>;
  }[] = [];

  const accountList = Array.from(unique.values());
  for (let i = 0; i < accountList.length; i += CONCURRENCY) {
    const batch = accountList.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (p) => {
        const id = p.accountId.toString();
        const metrics = await fetchAccountMetrics(id, tenantId);
        const breakdown = metrics.deductions?.breakdownByType || {};
        return {
          accountId: id,
          login: p.login?.toString() || '',
          totalDeductions: metrics.deductions?.totalDeductions || 0,
          violationTypes: Object.keys(breakdown).filter((k) => breakdown[k] > 0),
          breakdownByType: breakdown,
        };
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') accounts.push(r.value);
    }
  }

  return formatViolationsSummaryResponse(accounts);
}

async function handleHighRisk(tenantId: string): Promise<string> {
  const payouts = await fetchPendingPayouts({
    statuses: ['Pending'],
    limit: 1000,
  }, tenantId);

  const unique = new Map<string, (typeof payouts)[0]>();
  for (const p of payouts) {
    if (p.accountId && !unique.has(p.accountId)) unique.set(p.accountId, p);
  }

  const results: {
    accountId: string;
    login: string;
    plan: string;
    riskScore: ReturnType<typeof computeRiskScore>;
    payoutAmount: number;
    totalDeductions: number;
    isBlackListed: boolean;
  }[] = [];

  const accountList = Array.from(unique.values());
  for (let i = 0; i < accountList.length; i += CONCURRENCY) {
    const batch = accountList.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (p) => {
        const id = p.accountId.toString();
        const [account, metrics] = await Promise.all([
          fetchAccountDetails(id, tenantId),
          fetchAccountMetrics(id, tenantId),
        ]);
        const userId = account?.userId || p.userId;
        const user = userId ? await fetchUserDetails(userId, tenantId) : null;

        const riskScore = computeRiskScore({
          deductions: metrics.deductions,
          account,
          user,
          payoutAmount: p.amount || p.clientPayout || 0,
        });

        return {
          accountId: id,
          login: p.login?.toString() || account?.login?.toString() || '',
          plan: account?.planName || p.plan || '',
          riskScore,
          payoutAmount: p.amount || p.clientPayout || 0,
          totalDeductions: metrics.deductions?.totalDeductions || 0,
          isBlackListed: user?.isBlackListed === 1,
        };
      })
    );
    for (const r of batchResults) {
      if (r.status === 'fulfilled') results.push(r.value);
    }
  }

  return formatHighRiskResponse(results);
}

async function handleSecurityCheck(tenantId: string): Promise<string> {
  const payouts = await fetchPendingPayouts({
    statuses: ['Pending'],
    limit: 1000,
  }, tenantId);

  const unique = new Map<string, (typeof payouts)[0]>();
  for (const p of payouts) {
    if (p.accountId && !unique.has(p.accountId)) unique.set(p.accountId, p);
  }

  const blacklisted: { accountId: string; email: string; reason: string | null; payoutAmount: number }[] = [];
  const kycIssues: { accountId: string; email: string; kycStatus: string }[] = [];
  const allAnomalies: AnomalyFlag[] = [];

  const accountList = Array.from(unique.values());
  for (let i = 0; i < accountList.length; i += CONCURRENCY) {
    const batch = accountList.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (p) => {
        const id = p.accountId.toString();
        const [account, metrics] = await Promise.all([
          fetchAccountDetails(id, tenantId),
          fetchAccountMetrics(id, tenantId),
        ]);
        const userId = account?.userId || p.userId;
        const user = userId ? await fetchUserDetails(userId, tenantId) : null;

        if (user?.isBlackListed === 1) {
          blacklisted.push({
            accountId: id,
            email: user.email || p.email || '',
            reason: user.blackListReason || null,
            payoutAmount: p.amount || p.clientPayout || 0,
          });
        }

        if (user && user.isKycVerified !== 1) {
          kycIssues.push({
            accountId: id,
            email: user.email || p.email || '',
            kycStatus: user.kycStatus || 'Unknown',
          });
        }

        const anomalies = detectAnomalies({
          accountId: id,
          deductions: metrics.deductions,
          account,
          user,
          payoutAmount: p.amount || p.clientPayout || 0,
          payoutRequested: p.statusChanged || p.requested,
        });
        allAnomalies.push(...anomalies);
      })
    );
  }

  return formatSecurityCheckResponse({ blacklisted, kycIssues, anomalies: allAnomalies });
}

async function handleRiskScore(accountId: string | undefined, tenantId: string): Promise<string> {
  if (!accountId) {
    return '## Risk Score\n\nPlease provide an account ID. Example: **"risk score for 12345"**';
  }

  const [account, metrics] = await Promise.all([
    fetchAccountDetails(accountId, tenantId),
    fetchAccountMetrics(accountId, tenantId),
  ]);

  const userId = account?.userId;
  const user = userId ? await fetchUserDetails(userId, tenantId) : null;

  const riskScore = computeRiskScore({
    deductions: metrics.deductions,
    account,
    user,
  });

  return formatRiskScoreResponse(accountId, riskScore, account, metrics.deductions);
}

async function handleAccountTrades(accountId: string | undefined, tenantId: string): Promise<string> {
  if (!accountId) {
    return '## Trade History\n\nPlease provide an account ID. Example: **"trades for 12345"**';
  }

  // Need user email for foreign session
  const account = await fetchAccountDetails(accountId, tenantId);
  if (!account) {
    return `## Trade History\n\nAccount **${accountId}** not found.`;
  }

  const user = await fetchUserDetails(account.userId, tenantId);
  if (!user?.email) {
    return `## Trade History\n\nCannot retrieve trades for account **${accountId}** — user email not available.`;
  }

  const tradeData = await fetchAccountTradeData(accountId, user.email, tenantId);
  return formatAccountTradesResponse(
    accountId,
    tradeData?.stats || null,
    tradeData?.tradeTotal || 0
  );
}

async function handleAccountViolations(accountId: string | undefined, tenantId: string): Promise<string> {
  if (!accountId) {
    return '## Account Violations\n\nPlease provide an account ID. Example: **"violations for 12345"**';
  }

  const metrics = await fetchAccountMetrics(accountId, tenantId);
  return formatAccountViolationsResponse(accountId, metrics.deductions);
}

async function handleDeductionHistory(tenantId: string): Promise<string> {
  // Get recent payouts to find accounts with deductions, then fetch ledger events
  const payouts = await fetchPendingPayouts({
    statuses: ['Pending'],
    dateField: 'statusChanged',
    limit: 50,
  }, tenantId);

  // Get ledger events from first few accounts
  const allEvents: { accountId: number; event: string; time: string; data: Record<string, any> }[] = [];
  const seen = new Set<string>();

  for (const p of payouts.slice(0, 10)) {
    const id = p.accountId?.toString();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const events = await fetchLedgerEvents(id, { limit: 20 }, tenantId);
    for (const e of events) {
      if (e.event === 'cash_oper') {
        allEvents.push({
          accountId: e.accountId,
          event: e.event,
          time: e.time,
          data: e.data,
        });
      }
    }
  }

  // Sort by time descending
  allEvents.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  return formatDeductionHistoryResponse(allEvents);
}

async function handleGeneralQuestion(message: string, tenantId: string): Promise<string> {
  // Fetch current summary data to provide context-aware answers
  const payouts = await fetchPendingPayouts({
    statuses: ['Pending'],
    limit: 1000,
  }, tenantId);

  const totalAmount = payouts.reduce((s, p) => s + (p.amount || p.clientPayout || 0), 0);

  // Get violation data for top accounts
  const unique = new Map<string, (typeof payouts)[0]>();
  for (const p of payouts) {
    if (p.accountId && !unique.has(p.accountId)) unique.set(p.accountId, p);
  }

  const accountMetrics: { id: string; login: string; deductions: number; types: string[] }[] = [];
  const accountList = Array.from(unique.values()).slice(0, 20);
  const metricResults = await Promise.allSettled(
    accountList.map(async (p) => {
      const id = p.accountId.toString();
      const metrics = await fetchAccountMetrics(id, tenantId);
      const breakdown = metrics.deductions?.breakdownByType || {};
      return {
        id,
        login: p.login?.toString() || '',
        deductions: metrics.deductions?.totalDeductions || 0,
        types: Object.keys(breakdown).filter((k) => breakdown[k] > 0),
      };
    })
  );
  for (const r of metricResults) {
    if (r.status === 'fulfilled') accountMetrics.push(r.value);
  }

  const withViolations = accountMetrics.filter((a) => a.deductions > 0);
  const totalDeductions = withViolations.reduce((s, a) => s + a.deductions, 0);

  // Aggregate violation types
  const typeCounts: Record<string, number> = {};
  for (const a of withViolations) {
    for (const t of a.types) {
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
  }

  let md = `## Response to: "${message}"\n\n`;
  md += `Based on the current data from the Risk Management Platform:\n\n`;
  md += `### Current Status\n\n`;
  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| Pending Payouts | ${payouts.length} |\n`;
  md += `| Total Pending Amount | $${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })} |\n`;
  md += `| Accounts with Violations | ${withViolations.length} |\n`;
  md += `| Total Deductions | $${totalDeductions.toLocaleString('en-US', { minimumFractionDigits: 2 })} |\n`;

  if (Object.keys(typeCounts).length > 0) {
    md += `\n### Violation Types Detected\n\n`;
    md += `| Type | Accounts Affected |\n`;
    md += `|------|-------------------|\n`;
    const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sorted) {
      const label = type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      md += `| ${label} | ${count} |\n`;
    }
  }

  if (withViolations.length > 0) {
    md += `\n### Top Flagged Accounts\n\n`;
    md += `| Account | Login | Total Deductions |\n`;
    md += `|---------|-------|------------------|\n`;
    const top = [...withViolations].sort((a, b) => b.deductions - a.deductions).slice(0, 10);
    for (const a of top) {
      md += `| ${a.id} | ${a.login} | $${a.deductions.toFixed(2)} |\n`;
    }
  }

  md += `\n---\n*For more specific analysis, try commands like "account 12345", "high risk accounts", or "violations summary".*\n`;

  return md;
}

async function handleMorningReport(tenantId: string): Promise<string> {
  // Try database first
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from('morning_reports')
      .select('*')
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data?.data) {
      return formatMorningReportResponse(data.data as any);
    }
  } catch {
    // No database table — fall through to live generation
  }

  // Generate a live report on-the-fly
  try {
    const { generateMorningReportData } = await import('@/lib/ai/morning-report');
    const reportData = await generateMorningReportData(tenantId);
    return formatMorningReportResponse(reportData);
  } catch {
    return `## General Report\n\nUnable to generate the report at this time. Please try again or use specific commands like "pending payouts" or "violations summary".`;
  }
}

async function handleFraudHunt(tenantId: string): Promise<string> {
  try {
    const result = await runFraudHunterScan(tenantId);
    return formatFraudScanResponse(result);
  } catch {
    return `## Fraud Hunter\n\nUnable to run fraud scan at this time. Please try again later.`;
  }
}

async function handleFraudReport(tenantId: string): Promise<string> {
  try {
    const investigations = await getFraudInvestigations(tenantId, { status: ['open', 'reviewing'] });
    return formatFraudReportResponse(investigations);
  } catch {
    return `## Fraud Investigations\n\nUnable to fetch fraud investigations at this time.`;
  }
}

async function handleEnforcementQueue(): Promise<string> {
  try {
    const items = await getEnforcementQueue({ status: ['pending', 'auto_escalated'] });
    return formatEnforcementQueueResponse(items);
  } catch {
    return `## Enforcement Queue\n\nUnable to fetch enforcement queue at this time.`;
  }
}

async function handleEnforcementSummary(): Promise<string> {
  try {
    const summary = await getQueueSummary();
    return formatEnforcementSummaryResponse(summary);
  } catch {
    return `## Enforcement Summary\n\nUnable to fetch enforcement summary at this time.`;
  }
}

async function handleRepeatOffenders(): Promise<string> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('account_violation_history')
      .select('*')
      .gt('total_count', 1)
      .order('escalation_tier', { ascending: false })
      .order('total_count', { ascending: false })
      .limit(20);

    if (error) {
      return `## Repeat Offenders\n\nUnable to fetch repeat offender data.`;
    }

    const offenders = (data ?? []) as import('@/types/enforcement').AccountViolationHistory[];
    return formatRepeatOffendersResponse(offenders);
  } catch {
    return `## Repeat Offenders\n\nUnable to fetch repeat offender data at this time.`;
  }
}
