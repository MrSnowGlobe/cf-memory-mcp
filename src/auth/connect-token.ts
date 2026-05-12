import type { Bindings } from '../types';
import { isValidScopeId } from '../utils/ids';

/**
 * Short-lived signed token used to bind a scope to a WebSocket open without
 * relying on a custom header — which the browser WebSocket API can't send.
 *
 * Mint flow: the caller authenticates via Bearer or the Observatory cookie
 * and submits the desired `X-Project-Id` / `X-User-Id` to
 * POST /api/v1/events/token, which returns a token signed by the
 * deployment's AUTH_TOKEN. The caller appends that token to the WS open as
 * `?ws_token=` and the project-scope middleware verifies it before resolving
 * scope from headers/QPs. The token never grants new privileges — it just
 * carries the already-authorised scope through a channel that can't carry a
 * header.
 */
const TOKEN_VERSION = 'v1';
const DEFAULT_TTL_SECONDS = 60;
const DOMAIN_SEPARATOR = 'cf-agent-memory:ws_token';

export interface ConnectTokenClaims {
  projectId: string;
  userId: string;
  exp: number;
}

function bytesToHex(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    out += arr[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function signPayload(secret: string, payload: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${DOMAIN_SEPARATOR}|${payload}`)
  );
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
 * Mint a token. Format: `v1.{exp}.{projectId}.{userId}.{sig}`. Scope ids are
 * already constrained to [a-zA-Z0-9_-], so the dot separator is unambiguous
 * and no escaping is needed.
 */
export async function mintConnectToken(
  env: Bindings,
  projectId: string,
  userId: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<{ token: string; expires_in: number }> {
  if (!isValidScopeId(projectId) || !isValidScopeId(userId)) {
    throw new Error('Invalid scope ids for connect-token');
  }
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${TOKEN_VERSION}.${exp}.${projectId}.${userId}`;
  const sig = await signPayload(env.AUTH_TOKEN, payload);
  return { token: `${payload}.${sig}`, expires_in: ttlSeconds };
}

/**
 * Verify a token and return its claims, or null if invalid/expired. Never
 * throws — callers map null to a 401.
 */
export async function verifyConnectToken(
  env: Bindings,
  token: string
): Promise<ConnectTokenClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [version, expStr, projectId, userId, sig] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== TOKEN_VERSION) return null;
  if (!isValidScopeId(projectId) || !isValidScopeId(userId)) return null;

  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;

  const payload = `${version}.${expStr}.${projectId}.${userId}`;
  const expected = await signPayload(env.AUTH_TOKEN, payload);
  if (!constantTimeEqual(expected, sig)) return null;

  return { projectId, userId, exp };
}
