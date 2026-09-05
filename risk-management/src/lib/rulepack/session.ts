import type { SessionConfig } from './schema';

/**
 * Session-day bucketing.
 *
 * The engine this replaces derived a trading day with `iso.slice(0, 10)` — the
 * UTC calendar date. That is wrong for every futures firm and most forex ones.
 * The CME session for Monday opens at 17:00 ET on SUNDAY, so a trade at 18:00
 * Sunday belongs to Monday's daily-loss bucket; under the old rule it landed on
 * Sunday, splitting one session's losses across two buckets and under-reporting
 * both. A firm running a 5% daily loss limit would see breaches it should have
 * caught go unflagged.
 *
 * Implemented with Intl rather than a date library: the timezone database ships
 * with the runtime, so DST transitions are handled by the platform and there is
 * no dependency to drift.
 */

/** Wall-clock parts of an instant, in a given IANA zone. */
function zonedParts(instant: Date, timezone: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    // Intl renders midnight as '24' in some locales/runtimes; normalise it.
    hour: parts.hour === '24' ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function addDays(isoDate: string, days: number): string {
  // Anchored at noon UTC so a ±1 day step can never be swallowed by a DST
  // shift, then formatted back as a plain date.
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * The session day an instant belongs to, as `YYYY-MM-DD`.
 *
 * A session labelled D runs from `day_start` on D-1 through `day_start` on D.
 * So anything at or after `day_start` belongs to the NEXT calendar date's
 * session. `day_start` of '00:00' means the firm uses plain calendar days, and
 * the shift is skipped — without that special case every forex account would
 * have its whole history displaced by one day.
 */
export function sessionDayKey(isoTimestamp: string, session: SessionConfig): string {
  const instant = new Date(isoTimestamp);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`sessionDayKey: unparseable timestamp "${isoTimestamp}"`);
  }

  const { date, hour, minute } = zonedParts(instant, session.timezone);
  const startMinutes = minutesOf(session.day_start);
  if (startMinutes === 0) return date;

  return hour * 60 + minute >= startMinutes ? addDays(date, 1) : date;
}

/** Group anything timestamped into session-day buckets, preserving order. */
export function groupBySessionDay<T>(
  items: T[],
  session: SessionConfig,
  timestampOf: (item: T) => string
): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = sessionDayKey(timestampOf(item), session);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return buckets;
}

/** Whether an instant falls on or after a wall-clock time in the session zone. */
export function isAtOrAfterLocalTime(
  isoTimestamp: string,
  hhmm: string,
  session: SessionConfig
): boolean {
  const { hour, minute } = zonedParts(new Date(isoTimestamp), session.timezone);
  return hour * 60 + minute >= minutesOf(hhmm);
}

/** Local weekday (0 = Sunday) of an instant in the session zone. */
export function sessionWeekday(isoTimestamp: string, session: SessionConfig): number {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: session.timezone,
    weekday: 'short',
  }).format(new Date(isoTimestamp));

  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}
