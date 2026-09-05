/**
 * Shared HTTP helper for live provider adapters.
 *
 * Thin wrapper over fetch with a timeout, JSON parsing, and a typed error that
 * carries the status code so callers can distinguish auth failures (401/403)
 * from transient errors for retry/backoff.
 */
export class ProviderHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string
  ) {
    super(`Provider HTTP ${status} for ${url}: ${body.slice(0, 300)}`);
    this.name = 'ProviderHttpError';
  }
}

export interface FetchJsonOptions extends RequestInit {
  /** Abort after this many ms (default 20s). */
  timeoutMs?: number;
}

export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = 20_000, headers, ...rest } = opts;
  const res = await fetch(url, {
    ...rest,
    cache: 'no-store',
    signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json', ...headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ProviderHttpError(res.status, url, body);
  }
  // Some endpoints return 204/empty; guard JSON parse.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Bounded-concurrency map, preserving order. Failed items resolve to null. */
export async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency = 5
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
