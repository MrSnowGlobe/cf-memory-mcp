import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { globalRateLimitMiddleware } from '../../src/middleware/rate-limit';
import type { AppType, RateLimit } from '../../src/types';

/**
 * These tests exercise the middleware in isolation against a tiny Hono app.
 * The `RateLimit` binding is shape-compatible with `env.RL_GLOBAL`, so we can
 * drive the refusal path deterministically without a live Cloudflare binding.
 */
function buildApp() {
  const app = new Hono<AppType>();

  // Simulate the scope middleware that the real router chains before us.
  app.use('*', async (c, next) => {
    c.set('projectId', 'proj-a');
    c.set('userId', 'user-a');
    await next();
  });

  app.use('*', globalRateLimitMiddleware);
  app.get('/ok', (c) => c.text('ok'));
  return app;
}

function envWithLimiter(limiter: RateLimit | undefined) {
  // Only RL_GLOBAL matters for this middleware; cast so tests don't need to
  // construct every binding the real worker uses.
  return { RL_GLOBAL: limiter } as unknown as Parameters<
    ReturnType<typeof buildApp>['fetch']
  >[1];
}

describe('globalRateLimitMiddleware', () => {
  it('returns 429 when the limiter refuses a normal request', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const app = buildApp();

    const res = await app.fetch(new Request('http://local/ok'), envWithLimiter({ limit }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('10');
    expect(limit).toHaveBeenCalledOnce();
    expect(limit).toHaveBeenCalledWith({ key: 'proj-a:user-a' });
  });

  it('passes through when the limiter accepts', async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const app = buildApp();

    const res = await app.fetch(new Request('http://local/ok'), envWithLimiter({ limit }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('skips the limiter entirely for WebSocket upgrade requests', async () => {
    // Refusing limiter — if the middleware called it, this request would 429.
    const limit = vi.fn(async () => ({ success: false }));
    const app = buildApp();

    const res = await app.fetch(
      new Request('http://local/ok', { headers: { Upgrade: 'websocket' } }),
      envWithLimiter({ limit })
    );

    // Request reaches the handler (200), proving the WS upgrade bypassed
    // the limiter even under a refusing bucket.
    expect(res.status).toBe(200);
    // Critically, the limiter was never consulted — WS upgrades must not
    // burn a token, otherwise reconnects during load get silently 429'd.
    expect(limit).not.toHaveBeenCalled();
  });

  it('is a no-op when the binding is absent', async () => {
    const app = buildApp();
    const res = await app.fetch(new Request('http://local/ok'), envWithLimiter(undefined));
    expect(res.status).toBe(200);
  });
});
