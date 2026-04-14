import { createMiddleware } from 'hono/factory';
import type { AppType } from '../types';

/**
 * Timing-safe string comparison to prevent timing attacks on token validation.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do a comparison to avoid short-circuit timing leak on length
    const dummy = new Uint8Array(a.length);
    const dummyB = new Uint8Array(a.length);
    crypto.subtle.timingSafeEqual(dummy, dummyB);
    return false;
  }
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

export const authMiddleware = createMiddleware<AppType>(async (c, next) => {
  // Skip auth for health check
  if (c.req.path === '/health') {
    await next();
    return;
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.slice(7);
  if (!timingSafeEqual(token, c.env.AUTH_TOKEN)) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
});
