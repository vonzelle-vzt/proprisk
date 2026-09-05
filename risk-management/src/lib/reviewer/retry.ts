import { logWarn } from '@/lib/logging/logger';

interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 2000,
  maxDelayMs: 30000,
};

/**
 * Retry a function with exponential backoff and jitter.
 * Throws after all retries are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  opts?: Partial<RetryOptions>
): Promise<T> {
  const options = { ...DEFAULT_OPTIONS, ...opts };

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === options.maxRetries) {
        throw err;
      }

      const delay = Math.min(
        options.baseDelayMs * Math.pow(2, attempt),
        options.maxDelayMs
      ) + Math.random() * 500;

      logWarn(`Retry ${attempt + 1}/${options.maxRetries} for ${label}`, {
        category: 'external_api',
        attempt: attempt + 1,
        delay_ms: Math.round(delay),
        error: err instanceof Error ? err.message : String(err),
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error(`withRetry: exhausted retries for ${label}`);
}
