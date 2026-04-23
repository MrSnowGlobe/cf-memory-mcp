import { createMiddleware } from 'hono/factory';
import type { AppType, RateLimit } from '../types';

function enforce(
  limiter: RateLimit | undefined,
  key: string
): Promise<boolean> {
  if (!limiter) return Promise.resolve(true);
  return limiter.limit({ key }).then((r) => r.success);
}

/**
 * Protects AI-bound paths (embedding / search / context) from spikes that
 * would exhaust the Workers AI quota. Keyed per `{projectId}:{userId}`.
 * No-op when the `RL_AI` binding is not present (tests, local dev).
 */
export const aiRateLimitMiddleware = createMiddleware<AppType>(async (c, next) => {
  const projectId = c.get('projectId') ?? 'default';
  const userId = c.get('userId') ?? 'default';
  const ok = await enforce(c.env.RL_AI, `${projectId}:${userId}`);
  if (!ok) {
    c.header('Retry-After', '10');
    return c.json(
      { error: 'Rate limit exceeded for AI-bound operations', scope: `${projectId}:${userId}` },
      429
    );
  }
  await next();
});

/**
 * Per-MCP-method limiter. Callers pass the tool name so each method gets
 * its own bucket — a runaway `memory_add_entity` loop can't starve
 * `memory_search`. No-op when `RL_MCP` is not bound.
 */
export async function checkMcpMethodRate(
  limiter: RateLimit | undefined,
  projectId: string,
  userId: string,
  method: string
): Promise<boolean> {
  return enforce(limiter, `${projectId}:${userId}:${method}`);
}
