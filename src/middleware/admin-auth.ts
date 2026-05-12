import { createMiddleware } from 'hono/factory';
import type { AppType } from '../types';

/**
 * Constant-time string comparison via WebCrypto. Lengths are bucketed by
 * hashing both sides before comparison so the function never short-circuits
 * on length difference and never branches on attacker-controlled length.
 */
async function timingSafeEqualHashed(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ah, bh] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ah, bh);
}

/**
 * Separate bearer gate for /api/v1/admin/* routes. The regular AUTH_TOKEN is
 * a service-to-service credential held by every MCP client and agent in the
 * fleet; destructive admin operations need their own token so a leaked
 * AUTH_TOKEN doesn't grant data-loss capability.
 *
 * Runs AFTER authMiddleware — so the request is already authenticated by
 * AUTH_TOKEN or cookie. This middleware is an additional gate, not a
 * replacement. When `ADMIN_TOKEN` is unset, every admin request is refused
 * to avoid silent fail-open during partial rollout.
 */
export const adminAuthMiddleware = createMiddleware<AppType>(async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) {
    return c.json(
      { error: 'Admin routes are disabled on this deployment (ADMIN_TOKEN not set)' },
      503
    );
  }

  const authHeader = c.req.header('X-Admin-Token') ?? '';
  if (!authHeader) {
    c.header('WWW-Authenticate', 'X-Admin-Token');
    return c.json({ error: 'Admin token required' }, 401);
  }

  const ok = await timingSafeEqualHashed(authHeader, expected);
  if (!ok) {
    return c.json({ error: 'Invalid admin token' }, 403);
  }

  await next();
});

/**
 * Hex fingerprint of the supplied admin token for audit logs. Only the
 * first 8 hex chars — enough to correlate rows from the same caller without
 * storing material that could verify the secret.
 */
export async function adminCallerFingerprint(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const arr = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += arr[i]!.toString(16).padStart(2, '0');
  }
  return out;
}
