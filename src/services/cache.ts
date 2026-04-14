export async function cacheGet<T>(
  kv: KVNamespace,
  projectId: string,
  userId: string,
  key: string
): Promise<T | null> {
  const raw = await kv.get(`${projectId}:${userId}:${key}`);
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
  await kv.put(`${projectId}:${userId}:${key}`, JSON.stringify(value), {
    expirationTtl: ttlSeconds,
  });
}

export async function cacheDelete(
  kv: KVNamespace,
  projectId: string,
  userId: string,
  key: string
): Promise<void> {
  await kv.delete(`${projectId}:${userId}:${key}`);
}
