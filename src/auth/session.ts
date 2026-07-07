import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { AppType } from '../types';

const COOKIE_NAME = 'obs_session';
const SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60;
const SESSION_SCOPE = 'auth-v1';

/**
 * Browser-login session for the Observatory visualizer. Independent of
 * the AUTH_TOKEN bearer, which still works for service-to-service traffic
 * (MCP, scripts, agents). The cookie is HMAC-signed with the password
 * itself so any password rotation immediately invalidates issued sessions.
 */

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

function bytesToHex(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    out += arr[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return bytesToHex(sig);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Password comparison hashes both sides before the constant-time compare so
 * the length-mismatch early exit above never runs on attacker-controlled
 * input — a plain compare leaks the password's length via wall-clock time.
 * Cookie signature comparison keeps the plain path: both sides are fixed-
 * length hex HMACs, so there is no length signal to leak.
 */
async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ah, bh] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ah, bh);
}

async function buildCookieValue(secret: string): Promise<string> {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS;
  const payload = `${expiry}:${SESSION_SCOPE}`;
  const sig = await hmacHex(secret, payload);
  return `${expiry}.${sig}`;
}

async function isCookieValid(secret: string, value: string): Promise<boolean> {
  const dotIdx = value.indexOf('.');
  if (dotIdx === -1) return false;
  const expiryStr = value.slice(0, dotIdx);
  const sig = value.slice(dotIdx + 1);
  const expiry = Number.parseInt(expiryStr, 10);
  if (!Number.isFinite(expiry) || expiry < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacHex(secret, `${expiry}:${SESSION_SCOPE}`);
  return constantTimeEqual(expected, sig);
}

/** True if the request carries a valid session cookie. */
export async function hasValidSession(c: Context<AppType>): Promise<boolean> {
  const password = c.env.OBSERVATORY_PASSWORD;
  if (!password) return false;
  const cookie = getCookie(c, COOKIE_NAME);
  if (!cookie) return false;
  return isCookieValid(password, cookie);
}

export async function loginHandler(c: Context<AppType>): Promise<Response> {
  let body: { password?: string };
  try {
    body = await c.req.json<{ password?: string }>();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }
  const password = c.env.OBSERVATORY_PASSWORD;
  if (!password) {
    return c.json({ error: 'Browser login is not configured on this worker' }, 503);
  }
  if (!body.password || !(await timingSafeStringEqual(body.password, password))) {
    return c.json({ error: 'Invalid password' }, 401);
  }
  const value = await buildCookieValue(password);
  setCookie(c, COOKIE_NAME, value, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
    maxAge: SESSION_DURATION_SECONDS,
  });
  return c.json({ ok: true, expires_in: SESSION_DURATION_SECONDS });
}

export function logoutHandler(c: Context<AppType>): Response {
  deleteCookie(c, COOKIE_NAME, { path: '/' });
  return c.json({ ok: true });
}

export async function meHandler(c: Context<AppType>): Promise<Response> {
  const passwordConfigured = Boolean(c.env.OBSERVATORY_PASSWORD);
  const valid = await hasValidSession(c);
  return c.json({
    authenticated: valid,
    method: valid ? 'cookie' : null,
    password_required: passwordConfigured,
  });
}
