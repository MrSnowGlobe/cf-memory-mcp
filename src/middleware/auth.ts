import { createMiddleware } from 'hono/factory';
import type { AppType } from '../types';
import { hasValidSession } from '../auth/session';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    const dummy = new Uint8Array(a.length);
    const dummyB = new Uint8Array(a.length);
    crypto.subtle.timingSafeEqual(dummy, dummyB);
    return false;
  }
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

/**
 * Accept either a valid bearer token (service-to-service) or a valid
 * Observatory session cookie (browser login). Order matters: bearer is
 * checked first because it's the cheaper path — pure string compare,
 * no HMAC verification.
 */
export const authMiddleware = createMiddleware<AppType>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (timingSafeEqual(token, c.env.AUTH_TOKEN)) {
      await next();
      return;
    }
  }

  if (await hasValidSession(c)) {
    await next();
    return;
  }

  c.header('WWW-Authenticate', 'Bearer');
  return c.json({ error: 'Unauthorized' }, 401);
});
