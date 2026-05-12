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
 * Broad per-tenant cap across every `/api/*` and `/mcp/*` request. Stands in
 * for the edge-level WAF rate-limiting rule when a Pro plan isn't available.
 * Requests are billed (CPU + request count) before being rejected, but the
 * handler exits immediately so downstream D1/Vectorize/AI are untouched.
 * No-op when `RL_GLOBAL` is not bound.
 *
 * WebSocket upgrades are exempted: they represent a single long-lived
 * connection rather than a burst of work, and rate-limiting them makes
 * reconnects during write-heavy load silently fail (browser WS API hides
 * HTTP 429 from client JS, so the retry loop never surfaces the cause).
 */
export const globalRateLimitMiddleware = createMiddleware<AppType>(async (c, next) => {
  if (c.req.header('Upgrade') === 'websocket') {
    return next();
  }
  const projectId = c.get('projectId') ?? 'default';
  const userId = c.get('userId') ?? 'default';
  const ok = await enforce(c.env.RL_GLOBAL, `${projectId}:${userId}`);
  if (!ok) {
    c.header('Retry-After', '10');
    return c.json(
      { error: 'Rate limit exceeded', scope: `${projectId}:${userId}` },
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

/**
 * Pre-auth limiter for POST /auth/login. Keyed on the caller's IP so a
 * password-guessing attacker hits the cap before exhausting the search
 * space, but a legitimate user signing in from the same NAT as someone
 * else isn't punished for their neighbour's mistakes (still scoped per IP,
 * not per /24). No-op when `RL_LOGIN` is not bound.
 */
export const loginRateLimitMiddleware = createMiddleware<AppType>(async (c, next) => {
  const ip =
    c.req.header('CF-Connecting-IP') ??
    c.req.header('X-Forwarded-For') ??
    'unknown';
  const ok = await enforce(c.env.RL_LOGIN, `login:${ip}`);
  if (!ok) {
    c.header('Retry-After', '60');
    return c.json({ error: 'Too many login attempts. Try again in a minute.' }, 429);
  }
  await next();
});
