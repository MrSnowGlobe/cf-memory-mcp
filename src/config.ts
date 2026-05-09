export const EMBEDDING = {
  model: '@cf/google/embeddinggemma-300m',
  dimensions: 768,
  // embeddinggemma-300m tokenizer caps at 2048 tokens (~8000 chars).
  maxChars: 8000,
  batchSize: 100,
} as const;

export const RESOLUTION = {
  fuzzyThreshold: 0.85,
  semanticThreshold: 0.8,
  fuzzyCandidateLimit: 500,
} as const;

export const CASCADE_BOOSTS = {
  projectUser: 0.15,
  user: 0.10,
  project: 0.05,
  global: 0.0,
} as const;

export const CACHE_TTL = {
  conversationSeconds: 60,
  toolStatsSeconds: 300,
  // Embeddings are deterministic per (model, input) so they can stay
  // cached for a long time. Invalidates implicitly on model change
  // because the cache key includes the model id.
  embeddingSeconds: 86_400,
  // Short by design — buildContext output reflects the current memory
  // state at call time, so a long TTL would mask freshly-added entities/
  // facts on rapid follow-up reads. 60s captures conversational
  // re-asks (typo fixes, retries, near-duplicate prompts) without making
  // staleness perceptible.
  contextSeconds: 60,
} as const;

export const SSE = {
  pingIntervalMs: 30_000,
  maxDurationMs: 300_000,
} as const;

export const GRAPH = {
  defaultMaxDepth: 2,
  hardMaxDepth: 4,
  defaultLimit: 50,
  // Per-entity neighbor count when buildContext expands the top entities
  contextNeighborsPerEntity: 3,
  contextEntitiesToExpand: 3,
} as const;
