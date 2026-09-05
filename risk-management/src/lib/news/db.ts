import { createAdminClient } from '@/lib/supabase/admin';
import type { NewsEvent } from '@/lib/news/calendar';

const IMPACT_MAP: Record<string, string> = {
  red: 'High',
  orange: 'Medium',
  yellow: 'Low',
};

/**
 * Fetch news events from the `news_events` Supabase table for a given date range.
 * Returns them in the same `NewsEvent` shape used by the calendar module.
 */
export async function fetchNewsEventsFromDB(from: Date, to: Date): Promise<NewsEvent[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('news_events')
    .select('event_name, currency, impact_level, scheduled_at, source')
    .gte('scheduled_at', from.toISOString())
    .lte('scheduled_at', to.toISOString())
    .order('scheduled_at', { ascending: true });

  if (error || !data) return [];

  return data.map((row: any) => ({
    title: row.event_name,
    country: row.currency,
    date: row.scheduled_at,
    impact: IMPACT_MAP[row.impact_level] || 'Medium',
    source: row.source,
  }));
}

/**
 * Upsert news events into the `news_events` table.
 * Uses the unique index (event_name, currency, scheduled_at, source) for deduplication.
 * Returns the count of successfully upserted events.
 */
export async function upsertNewsEvents(events: NewsEvent[]): Promise<{ synced: number; skipped: number }> {
  const supabase = createAdminClient();
  const impactMap: Record<string, string> = { High: 'red', Medium: 'orange', Low: 'yellow' };

  let synced = 0;
  let skipped = 0;

  for (const event of events) {
    if (!event.date || !event.country) { skipped++; continue; }

    const impactLevel = impactMap[event.impact] || null;
    if (!impactLevel) { skipped++; continue; }

    const { error } = await supabase.from('news_events').upsert(
      {
        event_name: event.title,
        currency: event.country,
        impact_level: impactLevel,
        scheduled_at: event.date,
        source: event.source,
      },
      { onConflict: 'event_name,currency,scheduled_at,source' }
    );

    if (error) { skipped++; } else { synced++; }
  }

  return { synced, skipped };
}
