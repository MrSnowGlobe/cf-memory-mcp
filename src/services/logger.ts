/**
 * Structured JSON logger. Output goes to stdout via console.log, where
 * Workers Logs (and `wrangler tail`) ingests it as a single JSON object
 * per line. No external bindings — Workers Logs is included in the
 * Workers plan up to a daily ingest quota.
 *
 * Always-present fields: ts, level, event. Optional structured fields
 * (project_id, user_id, request_id, duration_ms, etc.) are merged in as
 * top-level keys so they are queryable in the dashboard without
 * unwrapping nested objects.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  request_id?: string;
  project_id?: string;
  user_id?: string;
  duration_ms?: number;
  status?: number;
  method?: string;
  path?: string;
  component?: string;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, event: string, fields: LogFields = {}): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function logInfo(event: string, fields?: LogFields): void {
  emit('info', event, fields);
}

export function logWarn(event: string, fields?: LogFields): void {
  emit('warn', event, fields);
}

export function logError(event: string, err: unknown, fields?: LogFields): void {
  const errorName = err instanceof Error ? err.constructor.name : 'UnknownError';
  const errorMessage = err instanceof Error ? err.message : String(err);
  emit('error', event, {
    ...fields,
    error: errorName,
    message: errorMessage,
  });
}

/** Emit an arbitrary structured log line. Prefer the level-specific helpers. */
export function log(level: LogLevel, event: string, fields?: LogFields): void {
  emit(level, event, fields);
}
