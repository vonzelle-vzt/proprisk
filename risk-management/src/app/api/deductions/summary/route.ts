import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { summaryQuerySchema, validationErrorResponse } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const supabase = await createClient();
  const { searchParams } = new URL(request.url);
  const parsed = summaryQuerySchema.safeParse(Object.fromEntries(searchParams.entries()));
  if (!parsed.success) return validationErrorResponse(parsed.error);
  const startDate =
    parsed.data.start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const endDate = parsed.data.end_date || new Date().toISOString().split('T')[0];

  const { data: deductions } = await supabase
    .from('deductions')
    .select(`
      *,
      accounts!inner(account_size, challenge_type, phase),
      violations(violation_type)
    `)
    .gte('executed_at', `${startDate}T00:00:00Z`)
    .lte('executed_at', `${endDate}T23:59:59Z`)
    .order('executed_at', { ascending: true });

  const items = deductions || [];

  // Time series (by date)
  const timeSeriesMap = new Map<string, { count: number; total_amount: number }>();
  items.forEach((d: any) => {
    const date = d.executed_at.split('T')[0];
    const existing = timeSeriesMap.get(date) || { count: 0, total_amount: 0 };
    existing.count++;
    existing.total_amount += d.amount;
    timeSeriesMap.set(date, existing);
  });
  const time_series = Array.from(timeSeriesMap.entries()).map(([date, stats]) => ({ date, ...stats }));

  // By violation type
  const byTypeMap = new Map<string, { count: number; total_amount: number }>();
  items.forEach((d: any) => {
    const type = d.violations?.violation_type || 'unknown';
    const existing = byTypeMap.get(type) || { count: 0, total_amount: 0 };
    existing.count++;
    existing.total_amount += d.amount;
    byTypeMap.set(type, existing);
  });
  const by_violation_type = Array.from(byTypeMap.entries()).map(([type, stats]) => ({ type, ...stats }));

  // By account size
  const bySizeMap = new Map<number, { count: number; total_amount: number }>();
  items.forEach((d: any) => {
    const size = d.accounts?.account_size || 0;
    const existing = bySizeMap.get(size) || { count: 0, total_amount: 0 };
    existing.count++;
    existing.total_amount += d.amount;
    bySizeMap.set(size, existing);
  });
  const by_account_size = Array.from(bySizeMap.entries()).map(([size, stats]) => ({ size, ...stats }));

  // By challenge type
  const byChallengeMap = new Map<string, { count: number; total_amount: number }>();
  items.forEach((d: any) => {
    const type = d.accounts?.challenge_type || 'unknown';
    const existing = byChallengeMap.get(type) || { count: 0, total_amount: 0 };
    existing.count++;
    existing.total_amount += d.amount;
    byChallengeMap.set(type, existing);
  });
  const by_challenge_type = Array.from(byChallengeMap.entries()).map(([type, stats]) => ({ type, ...stats }));

  return NextResponse.json({
    time_series,
    breakdowns: { by_violation_type, by_account_size, by_challenge_type },
    totals: {
      count: items.length,
      total_amount: items.reduce((sum: number, d: any) => sum + d.amount, 0),
    },
  });
}
