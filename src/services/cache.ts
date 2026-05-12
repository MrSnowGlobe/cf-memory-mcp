import { isValidScopeId } from '../utils/ids';

/**
 * Defence-in-depth: scope middleware validates projectId/userId at the door,
 * but if a future code path constructs cache keys outside that middleware
 * (background jobs, admin tools), this check stops a malformed segment from
 * collapsing the `{projectId}:{userId}:{key}` namespace and reading another
 * tenant's entries.
 */
function buildKey(projectId: string, userId: string, key: string): string {
  if (!isValidScopeId(projectId) || !isValidScopeId(userId)) {
    throw new Error('cache: invalid scope id segment');
  }
  return `${projectId}:${userId}:${key}`;
}

export async function cacheGet<T>(
  kv: KVNamespace,
  projectId: string,
  userId: string,
  key: string
): Promise<T | null> {
  const raw = await kv.get(buildKey(projectId, userId, key));
  if (raw === null) return null;
  return JSON.parse(raw) as T;
}

export async function cacheSet(
  kv: KVNamespace,
  projectId: string,
  userId: string,
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  await kv.put(buildKey(projectId, userId, key), JSON.stringify(value), {
    expirationTtl: ttlSeconds,
  });
}

export async function cacheDelete(
  kv: KVNamespace,
  projectId: string,
  userId: string,
  key: string
): Promise<void> {
  await kv.delete(buildKey(projectId, userId, key));
}
