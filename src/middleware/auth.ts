import { createMiddleware } from 'hono/factory';
import type { AppType } from '../types';
import { hasValidSession } from '../auth/session';

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  // Hash both sides first so the comparison always operates on equal-length
  // 32-byte buffers — eliminates the early-exit-on-length-mismatch branch
  // that the previous implementation tried to compensate for with a dummy
  // operation but which still leaked the secret's length via wall-clock
  // time. crypto.subtle.digest runs in constant time relative to inputs of
  // similar length, so the only timing signal left is "did the caller send
  // a comparable-length token", which is uninteresting.
  const encoder = new TextEncoder();
  const [ah, bh] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ah, bh);
}

/**
 * Accept either a valid bearer token (service-to-service) or a valid
 * Observatory session cookie (browser login). Order matters: bearer is
 * checked first because it's the cheaper path — pure string compare,
 * no HMAC verification.
 */
export const authMiddleware = createMiddleware<AppType>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  // Fail closed when the AUTH_TOKEN secret is missing: comparing against
  // undefined hashes an empty string on both sides, so `Bearer ` (empty
  // token) would authenticate. Mirrors the admin middleware's unset guard.
  if (authHeader?.startsWith('Bearer ') && c.env.AUTH_TOKEN) {
    const token = authHeader.slice(7);
    if (await timingSafeEqual(token, c.env.AUTH_TOKEN)) {
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
