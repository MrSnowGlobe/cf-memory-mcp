export const EMBEDDING = {
  model: '@cf/baai/bge-base-en-v1.5',
  dimensions: 768,
  // bge-base-en-v1.5 tokenizer caps at 512 tokens (~2000 chars).
  maxChars: 2000,
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
