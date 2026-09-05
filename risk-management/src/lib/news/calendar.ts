/**
 * Economic calendar integration.
 *
 * Sources (in priority order):
 * 1. FXStreet — date-range event queries via calendar API
 *    https://www.fxstreet.com/economic-calendar
 *
 * 2. Forex Factory — current week events from faireconomy.media JSON feed
 *    https://www.forexfactory.com/calendar
 *
 * For trade analysis the system:
 * 1. Determines the full date range of the trades being analyzed
 * 2. Fetches events from both sources covering that range
 * 3. Matches each trade against actual fetched events within a time window
 */

const FF_CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const FXSTREET_CALENDAR_API = 'https://calendar-api.fxstreet.com/en/api/v1/eventDates';

export interface NewsEvent {
  title: string;
  country: string;       // currency code: USD, EUR, GBP, etc.
  date: string;          // ISO timestamp
  impact: string;        // High, Medium, Low, Holiday
  forecast?: string;
  previous?: string;
  source: 'forex_factory' | 'fxstreet';
}

// ─── Caching ───────────────────────────────────────────────────────
// Cache by date-range key so repeated calls for the same period are fast.
const eventCache = new Map<string, { events: NewsEvent[]; fetchedAt: number }>();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

function getCached(key: string): NewsEvent[] | null {
  const entry = eventCache.get(key);
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL) return entry.events;
  return null;
}

function setCache(key: string, events: NewsEvent[]) {
  eventCache.set(key, { events, fetchedAt: Date.now() });
}

// ─── Forex Factory (current week, faireconomy.media feed) ─────────
// Only covers the current week. Free, no auth required.
async function fetchForexFactoryEvents(): Promise<NewsEvent[]> {
  const cached = getCached('ff_thisweek');
  if (cached) return cached;

  try {
    const res = await fetch(FF_CALENDAR_URL, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    const events: NewsEvent[] = (Array.isArray(data) ? data : []).map((e: any) => ({
      title: e.title || '',
      country: e.country || '',
      date: e.date || '',
      impact: e.impact || 'Medium',
      forecast: e.forecast,
      previous: e.previous,
      source: 'forex_factory' as const,
    })).filter((e: NewsEvent) => e.title && e.date);

    setCache('ff_thisweek', events);
    return events;
  } catch {
    return [];
  }
}

// ─── FXStreet ──────────────────────────────────────────────────────
// Supports historical date-range queries.
// Endpoint: /en/api/v1/eventDates/{from}/{to}
export async function fetchFXStreetEvents(from: Date, to: Date): Promise<NewsEvent[]> {
  const fromISO = from.toISOString();
  const toISO = to.toISOString();
  const cacheKey = `fxstreet:${fromISO.slice(0, 10)}:${toISO.slice(0, 10)}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const url = `${FXSTREET_CALENDAR_API}/${encodeURIComponent(fromISO)}/${encodeURIComponent(toISO)}`;
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();

    const events: NewsEvent[] = (Array.isArray(data) ? data : []).map((e: any) => ({
      title: e.name || e.title || '',
      country: e.currencyCode || e.countryCode || e.country || '',
      date: e.dateUtc || e.date || '',
      impact: normalizeFXStreetImpact(e.volatilityId ?? e.volatility ?? e.impact),
      forecast: e.consensus ?? e.forecast,
      previous: e.previous,
      source: 'fxstreet' as const,
    })).filter((e: NewsEvent) => e.title && e.date);

    setCache(cacheKey, events);
    return events;
  } catch {
    return [];
  }
}

function normalizeFXStreetImpact(v: unknown): string {
  if (v === 3 || v === 'HIGH' || v === 'High') return 'High';
  if (v === 2 || v === 'MEDIUM' || v === 'Medium') return 'Medium';
  if (v === 1 || v === 'LOW' || v === 'Low') return 'Low';
  if (typeof v === 'string') {
    const lower = v.toLowerCase();
    if (lower.includes('high')) return 'High';
    if (lower.includes('medium')) return 'Medium';
    if (lower.includes('low')) return 'Low';
  }
  return 'Medium';
}

// ─── Combined fetch ────────────────────────────────────────────────
/**
 * Fetch events from both FXStreet and Forex Factory for a given date range.
 * FXStreet supports arbitrary date ranges.
 * Forex Factory only covers the current week — events outside it are skipped.
 * Deduplicates by title + time (prefers Forex Factory when both have it).
 */
export async function fetchEventsForDateRange(from: Date, to: Date): Promise<NewsEvent[]> {
  const [ffEvents, fxsEvents] = await Promise.all([
    fetchForexFactoryEvents(),
    fetchFXStreetEvents(from, to),
  ]);

  // Filter FF events to the requested date range (FF returns full current week)
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const ffFiltered = ffEvents.filter((e) => {
    const ms = new Date(e.date).getTime();
    return ms >= fromMs && ms <= toMs;
  });

  // Combine — prefer Forex Factory for duplicates (add FF first)
  const seen = new Set<string>();
  const combined: NewsEvent[] = [];

  for (const e of ffFiltered) {
    const key = `${e.title.toLowerCase()}:${e.date.slice(0, 13)}`;
    if (!seen.has(key)) {
      seen.add(key);
      combined.push(e);
    }
  }

  for (const e of fxsEvents) {
    const key = `${e.title.toLowerCase()}:${e.date.slice(0, 13)}`;
    if (!seen.has(key)) {
      seen.add(key);
      combined.push(e);
    }
  }

  return combined;
}

// ─── Single trade match ────────────────────────────────────────────
/**
 * Given a trade's open time, find the closest economic news event
 * from FXStreet / Forex Factory within the time window.
 */
export async function matchNewsEvent(
  tradeOpenTime: string,
  symbol: string,
  windowMinutes = 5
): Promise<{
  event: string;
  currency: string;
  impact: string;
  eventTime: string;
  source: 'forex_factory' | 'fxstreet';
} | null> {
  const openDate = new Date(tradeOpenTime);
  const openMs = openDate.getTime();

  // Fetch events for the day of the trade
  const dayStart = new Date(openDate);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(openDate);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const events = await fetchEventsForDateRange(dayStart, dayEnd);
  const currencies = extractCurrencies(symbol);

  // Find the closest matching event within the window
  let bestMatch: { evt: NewsEvent; diffMin: number } | null = null;

  for (const evt of events) {
    if (evt.impact !== 'High' && evt.impact !== 'Medium') continue;

    // Currency must relate to the traded instrument
    if (currencies.length > 0 && !currencies.includes(evt.country)) continue;

    const evtMs = new Date(evt.date).getTime();
    const diffMin = Math.abs(openMs - evtMs) / 60000;

    if (diffMin <= windowMinutes) {
      // Prefer higher impact, then closer time
      if (
        !bestMatch ||
        (evt.impact === 'High' && bestMatch.evt.impact !== 'High') ||
        diffMin < bestMatch.diffMin
      ) {
        bestMatch = { evt, diffMin };
      }
    }
  }

  if (bestMatch) {
    return {
      event: bestMatch.evt.title,
      currency: bestMatch.evt.country,
      impact: bestMatch.evt.impact,
      eventTime: bestMatch.evt.date,
      source: bestMatch.evt.source,
    };
  }

  return null;
}

// ─── Batch match ───────────────────────────────────────────────────
/**
 * Batch match: given a list of trades flagged as news violations,
 * resolve all their news events at once.
 *
 * Pre-fetches events for the full date range of all trades so each
 * source is only called once.
 */
export async function matchNewsEventsForTrades(
  trades: Array<{ openTime: string; symbol: string }>
): Promise<Map<string, { event: string; currency: string; impact: string; eventTime: string; source: string }>> {
  const results = new Map<string, { event: string; currency: string; impact: string; eventTime: string; source: string }>();
  if (trades.length === 0) return results;

  // Determine the full date range across all trades
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const t of trades) {
    const ms = new Date(t.openTime).getTime();
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  }

  // Pre-fetch events for the full range (with 1-day buffer on each side)
  const rangeStart = new Date(minMs);
  rangeStart.setUTCHours(0, 0, 0, 0);
  const rangeEnd = new Date(maxMs);
  rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 1);
  rangeEnd.setUTCHours(23, 59, 59, 999);

  const allEvents = await fetchEventsForDateRange(rangeStart, rangeEnd);

  // Match each trade against the pre-fetched events
  for (const trade of trades) {
    const openDate = new Date(trade.openTime);
    const openMs = openDate.getTime();
    const currencies = extractCurrencies(trade.symbol);

    let bestMatch: { evt: NewsEvent; diffMin: number } | null = null;

    for (const evt of allEvents) {
      if (evt.impact !== 'High' && evt.impact !== 'Medium') continue;
      if (currencies.length > 0 && !currencies.includes(evt.country)) continue;

      const evtMs = new Date(evt.date).getTime();
      const diffMin = Math.abs(openMs - evtMs) / 60000;

      if (diffMin <= 5) {
        if (
          !bestMatch ||
          (evt.impact === 'High' && bestMatch.evt.impact !== 'High') ||
          diffMin < bestMatch.diffMin
        ) {
          bestMatch = { evt, diffMin };
        }
      }
    }

    if (bestMatch) {
      results.set(`${trade.openTime}:${trade.symbol}`, {
        event: bestMatch.evt.title,
        currency: bestMatch.evt.country,
        impact: bestMatch.evt.impact,
        eventTime: bestMatch.evt.date,
        source: bestMatch.evt.source,
      });
    }
  }

  return results;
}

// ─── Helpers ───────────────────────────────────────────────────────
/**
 * Extract currency codes from a forex symbol name.
 * e.g. "EURUSD" → ["EUR", "USD"], "XAUUSD" → ["USD"], "US30" → ["USD"]
 */
export function extractCurrencies(symbol: string): string[] {
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const currencies: string[] = [];
  const codes = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'NZD', 'CHF'];

  // Standard forex pairs: EURUSD, GBPJPY, etc.
  for (const code of codes) {
    if (sym.includes(code)) currencies.push(code);
  }

  // Indices and commodities default to USD
  if (currencies.length === 0) {
    const usdAssets = ['XAU', 'XAG', 'US30', 'US500', 'NAS', 'SPX', 'DJI', 'NDX', 'OIL', 'WTI', 'BRENT'];
    if (usdAssets.some(a => sym.includes(a))) currencies.push('USD');
  }

  return [...new Set(currencies)];
}
