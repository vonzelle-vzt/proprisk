import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRiskUser } from '@/lib/auth/guards';
import { accountLoginParamSchema, validationErrorResponse } from '@/lib/api/schemas';
import { DEMO_MODE } from '@/lib/demo';
import { buildAccount } from '@/lib/mock/builders';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: { login: string } }) {
  if (DEMO_MODE) return NextResponse.json(buildAccount(params.login));
  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const supabase = await createClient();
  const parsed = accountLoginParamSchema.safeParse(params);
  if (!parsed.success) return validationErrorResponse(parsed.error);
  const { login } = parsed.data;

  const { data: account, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('login', login)
    .single();

  if (error || !account) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  const [violationsRes, deductionsRes, emailsRes] = await Promise.all([
    supabase
      .from('violations')
      .select('*')
      .eq('account_id', account.id)
      .order('detected_at', { ascending: false })
      .limit(50),
    supabase
      .from('deductions')
      .select('*')
      .eq('account_id', account.id)
      .order('executed_at', { ascending: false })
      .limit(50),
    supabase
      .from('emails')
      .select('*')
      .eq('account_id', account.id)
      .order('sent_at', { ascending: false })
      .limit(50),
  ]);

  return NextResponse.json({
    ...account,
    violations: violationsRes.data || [],
    deductions: deductionsRes.data || [],
    emails: emailsRes.data || [],
  });
}
