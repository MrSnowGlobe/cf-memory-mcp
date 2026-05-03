import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppType } from '../types';
import { generateId } from '../utils/ids';
import { logInfo, logError } from '../services/logger';

/**
 * Request-lifecycle structured logger. Mints a request_id, captures
 * start time, and emits one `request_completed` event per request with
 * method, path, status, duration_ms, and the resolved project_id /
 * user_id (if scope middleware ran). Errors thrown downstream are logged
 * as `request_failed` with the same fields plus error details, then
 * re-thrown so app.onError still maps them to a JSON response.
 *
 * Wire this BEFORE auth so 401s and validation failures still produce a
 * log line — otherwise denied requests would be invisible.
 */
export const requestLogMiddleware = createMiddleware<AppType>(async (c, next) => {
  const requestId = generateId();
  c.set('requestId', requestId);
  const startMs = Date.now();
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;

  try {
    await next();
    const durationMs = Date.now() - startMs;
    logInfo('request_completed', {
      request_id: requestId,
      method,
      path,
      status: c.res.status,
      duration_ms: durationMs,
      project_id: safeGet(c, 'projectId'),
      user_id: safeGet(c, 'userId'),
    });
  } catch (err) {
    const durationMs = Date.now() - startMs;
    logError('request_failed', err, {
      request_id: requestId,
      method,
      path,
      duration_ms: durationMs,
      project_id: safeGet(c, 'projectId'),
      user_id: safeGet(c, 'userId'),
    });
    throw err;
  }
});

// Hono throws if the variable hasn't been set — middleware runs before
// scope middleware on auth failures, so we can't assume projectId/userId
// are set when emitting the log. Swallow the throw and return undefined.
function safeGet(c: Context<AppType>, key: 'projectId' | 'userId'): string | undefined {
  try {
    return c.get(key);
  } catch {
    return undefined;
  }
}
