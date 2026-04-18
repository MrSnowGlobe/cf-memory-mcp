import { env, applyD1Migrations } from 'cloudflare:test';
import type { Bindings, SearchResult } from '../../src/types';

// ---------------------------------------------------------------------------
// Migration helper
// ---------------------------------------------------------------------------


/**
 * Apply real migration files (migrations/*.sql) loaded via vitest.config.ts.
 * Single source of truth — no duplicated schema.
 */
export async function applyMigrations(db: D1Database): Promise<void> {
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
}

/**
 * Clear all data from tables so each test starts fresh.
 * Order matters because of foreign key references.
 */
export async function clearAllTables(db: D1Database): Promise<void> {
  const tables = [
    'tool_calls',
    'reasoning_steps',
    'tool_stats',
    'reasoning_traces',
    'promotion_log',
    'entity_relations',
    'messages',
    'sessions',
    'facts',
    'preferences',
    'entities',
    'users',
    'projects',
  ];

  for (const table of tables) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }

  // Re-seed global project
  await db
    .prepare("INSERT INTO projects (id, display_name) VALUES ('global', 'Global Memory')")
    .run();

  // Re-seed users
  await db
    .prepare("INSERT OR IGNORE INTO users (id, display_name) VALUES ('global', 'Global User')")
    .run();
  await db
    .prepare("INSERT OR IGNORE INTO users (id, display_name) VALUES ('default', 'Default User')")
    .run();
}

// ---------------------------------------------------------------------------
// Mock Vectorize
// ---------------------------------------------------------------------------

interface StoredVector {
  id: string;
  values: number[];
  namespace: string;
  metadata?: Record<string, string>;
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dotProduct += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dotProduct / denom;
}

/**
 * Create a mock VectorizeIndex that stores vectors in-memory.
 */
export function createMockVectorize(): VectorizeIndex {
  const store = new Map<string, StoredVector>();

  const mockIndex: VectorizeIndex = {
    insert: async (vectors: VectorizeVector[]): Promise<VectorizeVectorMutation> => {
      const ids: string[] = [];
      for (const v of vectors) {
        const key = `${v.namespace ?? '_default'}:${v.id}`;
        store.set(key, {
          id: v.id,
          values: Array.from(v.values),
          namespace: v.namespace ?? '_default',
          metadata: v.metadata as Record<string, string> | undefined,
        });
        ids.push(v.id);
      }
      return { ids, count: ids.length };
    },

    query: async (
      queryVector: number[] | Float32Array | Float64Array,
      options: VectorizeQueryOptions
    ): Promise<VectorizeMatches> => {
      const queryArr = Array.from(queryVector);
      const namespace = options.namespace ?? '_default';
      const topK = options.topK ?? 10;

      const candidates: Array<{ id: string; score: number; metadata?: Record<string, string> }> = [];

      for (const [, stored] of store) {
        if (stored.namespace !== namespace) continue;
        const score = cosineSimilarity(queryArr, stored.values);
        candidates.push({
          id: stored.id,
          score,
          metadata: stored.metadata,
        });
      }

      // Sort by score descending
      candidates.sort((a, b) => b.score - a.score);
      const topResults = candidates.slice(0, topK);

      const matches: VectorizeMatch[] = topResults.map((c) => ({
        id: c.id,
        score: c.score,
        metadata: c.metadata as Record<string, VectorizeVectorMetadata> | undefined,
        values: undefined,
        namespace: namespace,
      }));

      return { count: matches.length, matches };
    },

    deleteByIds: async (ids: string[]): Promise<VectorizeVectorMutation> => {
      const deletedIds: string[] = [];
      for (const [key, stored] of store) {
        if (ids.includes(stored.id)) {
          store.delete(key);
          deletedIds.push(stored.id);
        }
      }
      return { ids: deletedIds, count: deletedIds.length };
    },

    upsert: async (vectors: VectorizeVector[]): Promise<VectorizeVectorMutation> => {
      const ids: string[] = [];
      for (const v of vectors) {
        const key = `${v.namespace ?? '_default'}:${v.id}`;
        store.set(key, {
          id: v.id,
          values: Array.from(v.values),
          namespace: v.namespace ?? '_default',
          metadata: v.metadata as Record<string, string> | undefined,
        });
        ids.push(v.id);
      }
      return { ids, count: ids.length };
    },

    getByIds: async (ids: string[]): Promise<VectorizeVector[]> => {
      const results: VectorizeVector[] = [];
      for (const [, stored] of store) {
        if (ids.includes(stored.id)) {
          results.push({
            id: stored.id,
            values: new Float32Array(stored.values),
            namespace: stored.namespace,
            metadata: stored.metadata,
          });
        }
      }
      return results;
    },

    describe: async (): Promise<VectorizeIndexDetails> => {
      return {
        id: 'mock-index-id',
        name: 'mock-index',
        config: {
          dimensions: 768,
          metric: 'cosine',
        },
        vectorsCount: store.size,
      } as VectorizeIndexDetails;
    },
  };

  return mockIndex;
}

// ---------------------------------------------------------------------------
// Mock AI (Workers AI)
// ---------------------------------------------------------------------------

/**
 * Simple hash function to turn a string into a deterministic seed.
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + (str.charCodeAt(i) ?? 0)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Generate a deterministic 768-dim embedding from a text string.
 * The same text always produces the same embedding.
 */
function deterministicEmbedding(text: string): number[] {
  const dim = 768;
  const seed = hashString(text);
  const values = new Array<number>(dim);
  let s = seed;
  for (let i = 0; i < dim; i++) {
    // Simple pseudo-random from seed
    s = ((s * 1103515245 + 12345) & 0x7fffffff) >>> 0;
    values[i] = (s / 0x7fffffff) * 2 - 1; // range [-1, 1]
  }
  // Normalize to unit vector
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    const v = values[i]!;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      values[i] = values[i]! / norm;
    }
  }
  return values;
}

/**
 * Create a mock Ai binding that returns deterministic embeddings.
 */
export function createMockAI(): Ai {
  // Build a Proxy-based mock that handles ai.run() calls
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop) {
      if (prop === 'run') {
        return async (_model: string, input: { text: string[] }) => {
          const data = input.text.map((t) => deterministicEmbedding(t));
          return { shape: [data.length, 768], data };
        };
      }
      return undefined;
    },
  };

  return new Proxy({}, handler) as unknown as Ai;
}

// ---------------------------------------------------------------------------
// Test environment factory
// ---------------------------------------------------------------------------

export interface TestEnv extends Bindings {
  DB: D1Database;
  CACHE: KVNamespace;
  AI: Ai;
  VEC_MESSAGES: VectorizeIndex;
  VEC_ENTITIES: VectorizeIndex;
  VEC_PREFERENCES: VectorizeIndex;
  VEC_FACTS: VectorizeIndex;
  VEC_TRACES: VectorizeIndex;
  AUTH_TOKEN: string;
  EMBEDDING_MODEL: string;
  EMBEDDING_DIMENSIONS: string;
}

/**
 * Build a complete Bindings-compatible environment for tests.
 * D1 and KV come from Miniflare; Vectorize and AI are mocked.
 */
export function createTestEnv(db: D1Database, kv: KVNamespace): TestEnv {
  return {
    DB: db,
    CACHE: kv,
    AI: createMockAI(),
    VEC_MESSAGES: createMockVectorize(),
    VEC_ENTITIES: createMockVectorize(),
    VEC_PREFERENCES: createMockVectorize(),
    VEC_FACTS: createMockVectorize(),
    VEC_TRACES: createMockVectorize(),
    AUTH_TOKEN: 'test-token',
    EMBEDDING_MODEL: '@cf/baai/bge-base-en-v1.5',
    EMBEDDING_DIMENSIONS: '768',
  };
}

/**
 * Seed a project in the projects table (INSERT OR IGNORE).
 */
export async function seedProject(
  db: D1Database,
  projectId: string,
  displayName?: string
): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO projects (id, display_name) VALUES (?, ?)')
    .bind(projectId, displayName ?? projectId)
    .run();
}

/**
 * Seed a user in the users table (INSERT OR IGNORE).
 */
export async function seedUser(
  db: D1Database,
  userId: string,
  displayName?: string
): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO users (id, display_name) VALUES (?, ?)')
    .bind(userId, displayName ?? userId)
    .run();
}
