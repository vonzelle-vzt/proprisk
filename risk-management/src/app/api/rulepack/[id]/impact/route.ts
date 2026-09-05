export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRiskUser } from '@/lib/auth/guards';
import { tenantDb } from '@/lib/db/tenant-scoped';
import { activePack } from '@/lib/rulepack/store';
import { previewImpact, type AccountImpactInput } from '@/lib/rulepack/impact';
import { DEMO_MODE } from '@/lib/demo';
import { rulePackErrorResponse } from '../../_lib/errors';
import { findPack } from '../../_lib/get-pack';

const idParamSchema = z.object({ id: z.string().uuid() });

const OPEN_PHASES = ['challenge', 'verification', 'funded'] as const;

/** One row of `accounts`, the columns this route needs. */
interface AccountRow {
  id: string;
  login: string;
  phase: (typeof OPEN_PHASES)[number];
  account_size: number;
  balance: number;
  equity: number;
}

/**
 * Impact preview: which open accounts would change status under this
 * candidate pack, compared to whatever is active today.
 *
 * IMPORTANT LIMITATION: there is no ingested trade/equity history for live
 * accounts yet (see the note on the backtest route), so each account is
 * evaluated from its CURRENT balance/equity only — a single synthetic trade
 * and snapshot standing in for its whole history. This is enough for rules
 * that key off where an account sits right now (drawdown, daily loss), and it
 * is exactly the failure mode this preview exists to catch — a threshold edit
 * that instantly breaches accounts sitting near their floor. It cannot see
 * rules that depend on a trading pattern over time (HFT, martingale, grid,
 * consistency), which the evaluator correctly reports as `skipped` rather than
 * silently passing.
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  if (DEMO_MODE) {
    return NextResponse.json({
      data: { accountsEvaluated: 0, changed: [], unchangedCount: 0, newTerminations: 0, summary: 'Demo mode: no live accounts to preview.' },
      demo: true,
    });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const parsedParams = idParamSchema.safeParse(params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: 'Invalid rule pack id' }, { status: 400 });
  }

  try {
    const candidate = await findPack(auth.tenantId, parsedParams.data.id);
    if (!candidate) return NextResponse.json({ error: 'Rule pack not found' }, { status: 404 });

    const current = await activePack(auth.tenantId, candidate.assetClass);

    const db = tenantDb(auth.tenantId, 'GET /api/rulepack/[id]/impact');
    const { data: rows, error } = await db
      .select('accounts', 'id, login, phase, account_size, balance, equity')
      .eq('is_active', true)
      .in('phase', [...OPEN_PHASES])
      .limit(5000);

    if (error) throw error;

    const now = new Date().toISOString();
    const accounts: AccountImpactInput[] = ((rows ?? []) as unknown as AccountRow[]).map((row) => ({
      accountId: row.id,
      login: row.login,
      input: {
        account: {
          id: row.id,
          login: row.login,
          phase: row.phase,
          startingBalance: row.account_size,
          currentBalance: row.balance,
          currentEquity: row.equity,
        },
        // A single synthetic trade/snapshot at "now" — see the limitation
        // note above. Real per-trade history would replace this entirely.
        trades: [
          {
            id: `${row.id}-current-state`,
            symbol: '-',
            openTime: now,
            closeTime: now,
            profit: row.balance - row.account_size,
            size: 0,
            isOpen: false,
          },
        ],
        snapshots: [{ at: now, balance: row.balance, equity: row.equity }],
        now,
      },
    }));

    const report = previewImpact(current?.pack ?? null, candidate.pack, accounts);

    return NextResponse.json({
      data: report,
      note:
        'Evaluated from each account\'s current balance/equity only, not full trade history. ' +
        'Rules that depend on a trading pattern over time are excluded, not silently passed.',
    });
  } catch (err) {
    return rulePackErrorResponse(err, 'GET /api/rulepack/[id]/impact');
  }
}
