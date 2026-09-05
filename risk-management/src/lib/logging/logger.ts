export type LogLevel = 'info' | 'warn' | 'error';
export type ErrorCategory = 'external_api' | 'database' | 'auth' | 'validation' | 'internal' | 'cron';

export interface LogContext {
  route?: string;
  method?: string;
  duration_ms?: number;
  category?: ErrorCategory;
  payout_id?: string;
  account_id?: string;
  [key: string]: unknown;
}

function extractError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

function emit(level: LogLevel, message: string, context?: LogContext & { error?: string; stack?: string }) {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context,
  };

  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(JSON.stringify(entry));
}

export function logInfo(message: string, context?: LogContext): void {
  emit('info', message, context);
}

export function logWarn(message: string, context?: LogContext): void {
  emit('warn', message, context);
}

export function logError(message: string, err: unknown, context?: LogContext): void {
  const { message: errMsg, stack } = extractError(err);
  emit('error', message, { ...context, error: errMsg, stack });
}

export function cronMetrics(
  jobName: string,
  startTime: number,
  result: { processed: number; errors: number; skipped?: number }
): void {
  const duration_ms = Date.now() - startTime;
  emit('info', `cron:${jobName} completed`, {
    category: 'cron',
    duration_ms,
    job: jobName,
    ...result,
  });
}
