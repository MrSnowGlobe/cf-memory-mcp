import { EMBEDDING, CACHE_TTL } from '../config';
import { logError } from './logger';

function truncateForEmbedding(text: string): string {
  return text.length > EMBEDDING.maxChars ? text.slice(0, EMBEDDING.maxChars) : text;
}

export async function getEmbedding(text: string, ai: Ai): Promise<number[]> {
  const result = await ai.run(EMBEDDING.model, { text: [truncateForEmbedding(text)] });
  if ('data' in result && result.data) {
    const first = result.data[0];
    if (!first) {
      throw new Error('Embedding returned empty data array');
    }
    return first;
  }
  throw new Error('Unexpected embedding response format');
}

// Cache key prefix — includes the model id so swapping models implicitly
// invalidates every cached entry instead of returning vectors from the
// wrong embedding space.
const EMBED_CACHE_PREFIX = `emb:${EMBEDDING.model}:`;

async function hashText(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Embed `text` with KV-backed caching. Embeddings are deterministic per
 * (model, input) so the cache is keyed by sha256(truncated text) under
 * the model-specific prefix. Cache reads/writes are tenant-agnostic on
 * purpose — the key requires you to already know the exact query text,
 * and the value is purely a function of that text, so no cross-tenant
 * information leaks via the cache.
 */
export async function getEmbeddingCached(
  text: string,
  ai: Ai,
  cache: KVNamespace
): Promise<number[]> {
  const truncated = truncateForEmbedding(text);
  const key = EMBED_CACHE_PREFIX + (await hashText(truncated));

  const hit = await cache.get<number[]>(key, 'json');
  if (hit) return hit;

  const result = await ai.run(EMBEDDING.model, { text: [truncated] });
  if (!('data' in result) || !result.data) {
    throw new Error('Unexpected embedding response format');
  }
  const embedding = result.data[0];
  if (!embedding) {
    throw new Error('Embedding returned empty data array');
  }

  // Awaited intentionally: leaving this as fire-and-forget races with
  // Miniflare's isolated-storage cleanup in tests. The added latency on
  // cache miss is small relative to the Workers AI call we just made,
  // and the cache-hit hot path (returns above) doesn't pay this cost.
  try {
    await cache.put(key, JSON.stringify(embedding), {
      expirationTtl: CACHE_TTL.embeddingSeconds,
    });
  } catch (err) {
    logError('embedding_cache_put_failed', err, { component: 'embedding-cache' });
  }

  return embedding;
}

export async function getEmbeddings(texts: string[], ai: Ai): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING.batchSize) {
    const batch = texts.slice(i, i + EMBEDDING.batchSize).map(truncateForEmbedding);
    const result = await ai.run(EMBEDDING.model, { text: batch });
    if ('data' in result && result.data) {
      results.push(...result.data);
    } else {
      throw new Error('Unexpected embedding response format');
    }
  }
  return results;
}

export function entityEmbeddingText(name: string, description: string | null): string {
  return description ? `${name}. ${description}` : name;
}

export function preferenceEmbeddingText(
  category: string,
  preference: string,
  context: string | null
): string {
  return context ? `${category}: ${preference} (${context})` : `${category}: ${preference}`;
}

export function factEmbeddingText(subject: string, predicate: string, object: string): string {
  return `${subject} ${predicate} ${object}`;
}
