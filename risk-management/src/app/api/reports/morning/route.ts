export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { generateMorningReportData, formatMorningReport } from '@/lib/ai/morning-report';
import { requireRiskUser } from '@/lib/auth/guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit/limiter';
import { logError } from '@/lib/logging/logger';
import { DEMO_MODE } from '@/lib/demo';

export async function POST() {
  if (DEMO_MODE) {
    return Response.json({
      summary:
        '## Morning Risk Report\n\nAcross all connected trading platforms (Forex + Futures): **58 accounts** monitored, **24 flagged** for review, **$18,400** in deductions pending. Top risk: trailing-drawdown breaches on 3 futures accounts and overleveraging on 5 forex accounts. No critical escalations require immediate action.',
      generatedAt: new Date().toISOString(),
      demo: true,
    });
  }

  const auth = await requireRiskUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit('morning-report', { windowMs: 60_000, maxRequests: 3 });
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const reportData = await generateMorningReportData(auth.tenantId);
    const summary = formatMorningReport(reportData);

    return Response.json({
      data: reportData,
      summary,
      generated_at: reportData.generated_at,
    });
  } catch (err) {
    logError('Failed to generate morning report', err, { route: '/api/reports/morning', category: 'internal' });
    return Response.json(
      { error: 'Failed to generate morning report' },
      { status: 500 }
    );
  }
}
