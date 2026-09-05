import { NextResponse } from 'next/server';
import { upsertNewsEvents } from '@/lib/news/db';
import type { NewsEvent } from '@/lib/news/calendar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes for large backfill

/**
 * Backfill endpoint: accepts raw Forex Factory calendar JSON (from browser dev tools)
 * and upserts events into the news_events table.
 *
 * Usage: POST /api/cron/backfill-news
 * Auth: Bearer CRON_SECRET
 * Body: Raw FF JSON payload with { days: [{ dateline, events: [{ name, currency, dateline, impactName, ... }] }] }
 */
export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const days = body?.days;

    if (!Array.isArray(days)) {
      return NextResponse.json(
        { error: 'Invalid payload — expected { days: [...] } from Forex Factory calendar JSON' },
        { status: 400 }
      );
    }

    // Parse FF days[].events[] into NewsEvent[]
    const events: NewsEvent[] = [];
    for (const day of days) {
      if (!Array.isArray(day.events)) continue;
      for (const e of day.events) {
        if (!e.name || !e.dateline) continue;
        events.push({
          title: e.prefixedName || e.name,
          country: e.currency || e.country || '',
          date: new Date(e.dateline * 1000).toISOString(),
          impact: normalizeFFImpact(e.impactName),
          forecast: e.forecast,
          previous: e.previous,
          source: 'forex_factory' as const,
        });
      }
    }

    if (events.length === 0) {
      return NextResponse.json({ message: 'No events found in payload', synced: 0, skipped: 0 });
    }

    const { synced, skipped } = await upsertNewsEvents(events);

    return NextResponse.json({
      message: 'Backfill complete',
      totalEvents: events.length,
      synced,
      skipped,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: 'Backfill failed', details: error?.message },
      { status: 500 }
    );
  }
}

function normalizeFFImpact(name: unknown): string {
  if (typeof name !== 'string') return 'Medium';
  const lower = name.toLowerCase();
  if (lower === 'high' || lower.includes('high')) return 'High';
  if (lower === 'medium' || lower.includes('medium')) return 'Medium';
  if (lower === 'low' || lower.includes('low')) return 'Low';
  return 'Medium';
}
