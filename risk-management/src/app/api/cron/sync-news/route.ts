import { NextResponse } from 'next/server';
import { fetchEventsForDateRange } from '@/lib/news/calendar';
import { upsertNewsEvents } from '@/lib/news/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Fetch this week's events from both FXStreet and Forex Factory
    const today = new Date();
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay() + 1);
    weekStart.setUTCHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setUTCHours(23, 59, 59, 999);

    const events = await fetchEventsForDateRange(weekStart, weekEnd);
    const { synced, skipped } = await upsertNewsEvents(events);

    return NextResponse.json({
      message: 'News sync complete',
      synced,
      skipped,
      sources: ['forex_factory', 'fxstreet'],
      range: { from: weekStart.toISOString(), to: weekEnd.toISOString() },
    });
  } catch (error: any) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
