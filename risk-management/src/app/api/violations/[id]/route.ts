import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { validationErrorResponse, violationIdParamSchema } from '@/lib/api/schemas';
import { DEMO_MODE } from '@/lib/demo';
import { buildViolationDetail } from '@/lib/mock/builders';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  if (DEMO_MODE) return NextResponse.json({ data: buildViolationDetail(params.id) });
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const supabase = await createClient();
  const parsed = violationIdParamSchema.safeParse(params);
  if (!parsed.success) return validationErrorResponse(parsed.error);
  const violationId = parsed.data.id;

  const { data: violation, error } = await supabase
    .from('violations')
    .select(`
      *,
      accounts(*)
    `)
    .eq('id', violationId)
    .single();

  if (error || !violation) return NextResponse.json({ error: 'Violation not found' }, { status: 404 });

  const [tradesRes, deductionsRes, emailsRes] = await Promise.all([
    supabase
      .from('trades')
      .select('*')
      .in('id', violation.related_trade_ids || []),
    supabase
      .from('deductions')
      .select('*')
      .eq('violation_id', violation.id)
      .order('executed_at', { ascending: false }),
    supabase
      .from('emails')
      .select('*')
      .eq('violation_id', violation.id)
      .order('sent_at', { ascending: false }),
  ]);

  let networkEvidence: Record<string, unknown> | null = null;
  if (violation.violation_type === 'grid' || violation.violation_type === 'copy') {
    const details = (violation.details_json || {}) as Record<string, any>;
    const accountAId = details.account_a_id || details.leader_account_id || null;
    const accountBId = details.account_b_id || details.follower_account_id || null;
    const matchedTrades = Array.isArray(details.matched_trades) ? details.matched_trades : [];

    if (accountAId && accountBId) {
      const { data: linkedAccounts } = await supabase
        .from('accounts')
        .select('id, login, trader_name, user_profile_id')
        .in('id', [accountAId, accountBId]);

      const accountA = (linkedAccounts || []).find((a: any) => a.id === accountAId) || null;
      const accountB = (linkedAccounts || []).find((a: any) => a.id === accountBId) || null;
      const allTrades = tradesRes.data || [];
      const tradesById = new Map<string, any>(allTrades.map((t: any) => [t.id, t]));

      const accountATrades = allTrades.filter((t: any) => t.account_id === accountAId);
      const accountBTrades = allTrades.filter((t: any) => t.account_id === accountBId);
      const matchedPairs = matchedTrades.map((m: any) => {
        const aTradeId = m.account_a_trade_id || m.leader_trade_id;
        const bTradeId = m.account_b_trade_id || m.follower_trade_id;
        return {
          symbol: m.symbol,
          lag_seconds: m.lag_seconds ?? m.time_diff_seconds ?? null,
          lot_diff_pct: m.lot_size_diff_pct ?? null,
          account_a_trade: aTradeId ? tradesById.get(aTradeId) || null : null,
          account_b_trade: bTradeId ? tradesById.get(bTradeId) || null : null,
        };
      });

      networkEvidence = {
        account_a: accountA,
        account_b: accountB,
        account_a_trades: accountATrades,
        account_b_trades: accountBTrades,
        matched_pairs: matchedPairs,
      };
    }
  }

  return NextResponse.json({
    ...violation,
    trades: tradesRes.data || [],
    deductions: deductionsRes.data || [],
    emails: emailsRes.data || [],
    network_evidence: networkEvidence,
  });
}
