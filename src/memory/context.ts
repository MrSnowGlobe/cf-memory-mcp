import type {
  Bindings,
  ContextInput,
  MessageRow,
  EntityRow,
  NeighborRow,
  PreferenceRow,
  FactRow,
  TraceRow,
  SearchResult,
} from '../types';
import { ShortTermMemory } from './short-term';
import { LongTermMemory } from './long-term';
import { ProceduralMemory } from './procedural';
import { getEmbeddingCached } from '../services/embeddings';
import { traverseRelations } from '../services/graph';
import { logError } from '../services/logger';
import { GRAPH } from '../config';

/** Default limits for each memory section when not specified by caller. */
const DEFAULT_LIMITS = {
  messages: 10,
  entities: 5,
  preferences: 5,
  facts: 5,
  traces: 3,
} as const;

/** A partial-failure record surfaced to the caller. */
export interface ContextError {
  source: string;
  message: string;
}

export interface BuildContextResult {
  context: string;
  errors: ContextError[];
}

/**
 * Builds a unified context by querying all three memory subsystems in
 * parallel. Returns the formatted text plus any per-query errors that were
 * swallowed internally, so callers can surface partial failures.
 */
export async function buildContext(
  env: Bindings,
  projectId: string,
  userId: string,
  input: ContextInput
): Promise<BuildContextResult> {
  const errors: ContextError[] = [];
  const safe = makeSafeQuery(errors, projectId, userId);
  const include = input.include ?? ['short_term', 'long_term', 'procedural'];
  const limits = {
    messages: input.limits?.messages ?? DEFAULT_LIMITS.messages,
    entities: input.limits?.entities ?? DEFAULT_LIMITS.entities,
    preferences: input.limits?.preferences ?? DEFAULT_LIMITS.preferences,
    facts: input.limits?.facts ?? DEFAULT_LIMITS.facts,
    traces: input.limits?.traces ?? DEFAULT_LIMITS.traces,
  };

  // Instantiate memory classes
  const shortTerm = new ShortTermMemory(env, projectId, userId);
  const longTerm = new LongTermMemory(env, projectId, userId);
  const procedural = new ProceduralMemory(env, projectId, userId);

  // Embed the query once and share the result across every search below.
  // Without this, each search method would call Workers AI separately —
  // 5 redundant calls per buildContext for an embedding that's identical
  // every time (same string, same model).
  const queryEmbedding = await safeOnce('query_embedding', errors, projectId, userId, () =>
    getEmbeddingCached(input.query, env.AI, env.CACHE)
  );

  // ------------------------------------------------------------------
  // 1. Fire all queries in parallel
  // ------------------------------------------------------------------
  type MaybeMessages = MessageRow[];
  type MaybeSearchResults = SearchResult[];

  const conversationPromise: Promise<MaybeMessages> =
    include.includes('short_term') && input.session_id
      ? safe('conversation', () =>
          shortTerm.getConversation(input.session_id!, limits.messages)
        )
      : Promise.resolve([]);

  // If embedding generation failed (queryEmbedding === null), the search
  // promises below short-circuit to []. The error is already in `errors`.
  const messageSearchPromise: Promise<MaybeSearchResults> =
    include.includes('short_term') && queryEmbedding
      ? safe('message_search', () =>
          shortTerm.searchMessages(input.query, {
            limit: limits.messages,
            embedding: queryEmbedding,
          })
        )
      : Promise.resolve([]);

  const entitySearchPromise: Promise<MaybeSearchResults> =
    include.includes('long_term') && queryEmbedding
      ? safe('entity_search', () =>
          longTerm.searchEntities(input.query, limits.entities, queryEmbedding)
        )
      : Promise.resolve([]);

  const preferenceSearchPromise: Promise<MaybeSearchResults> =
    include.includes('long_term') && queryEmbedding
      ? safe('preference_search', () =>
          longTerm.searchPreferences(input.query, limits.preferences, queryEmbedding)
        )
      : Promise.resolve([]);

  const factSearchPromise: Promise<MaybeSearchResults> =
    include.includes('long_term') && queryEmbedding
      ? safe('fact_search', () =>
          longTerm.searchFacts(input.query, limits.facts, queryEmbedding)
        )
      : Promise.resolve([]);

  const traceSearchPromise: Promise<MaybeSearchResults> =
    include.includes('procedural') && queryEmbedding
      ? safe('trace_search', () =>
          procedural.searchTraces(input.query, limits.traces, queryEmbedding)
        )
      : Promise.resolve([]);

  const [
    conversation,
    messageResults,
    entityResults,
    preferenceResults,
    factResults,
    traceResults,
  ] = await Promise.all([
    conversationPromise,
    messageSearchPromise,
    entitySearchPromise,
    preferenceSearchPromise,
    factSearchPromise,
    traceSearchPromise,
  ]);

  // ------------------------------------------------------------------
  // 2. Hydrate search results, and (in parallel) fan out neighbor
  //    traversal for the top-ranked entity ids. Neighbors only need ids
  //    — already present in entityResults — so traversal doesn't have
  //    to wait for hydration to finish.
  // ------------------------------------------------------------------
  const topRootIds = entityResults
    .slice(0, GRAPH.contextEntitiesToExpand)
    .map((r) => r.id);

  const neighborsPromise: Promise<NeighborGroup[]> =
    include.includes('long_term') && topRootIds.length > 0
      ? fetchNeighborGroupsByIds(env, projectId, userId, topRootIds, safe)
      : Promise.resolve([]);

  const [messages, entities, preferences, facts, traces, neighborGroups] = await Promise.all([
    hydrateMessages(env, messageResults, safe),
    hydrateEntities(env, entityResults, safe),
    hydratePreferences(env, preferenceResults, safe),
    hydrateFacts(env, factResults, safe),
    hydrateTraces(env, traceResults, safe),
    neighborsPromise,
  ]);

  // ------------------------------------------------------------------
  // 3. Build the formatted output, omitting empty sections
  // ------------------------------------------------------------------
  const sections: string[] = [];

  // Recent Conversation
  if (conversation.length > 0) {
    const lines = conversation.map((m) => `${m.role}: ${m.content}`);
    sections.push(`## Recent Conversation\n${lines.join('\n')}`);
  }

  // Relevant Messages (from search)
  if (messages.length > 0) {
    const lines = messages.map(({ row, score }) => {
      const snippet = truncate(row.content, 200);
      return `- ${snippet} (score: ${score.toFixed(3)})`;
    });
    sections.push(`## Relevant Messages\n${lines.join('\n')}`);
  }

  // Known Entities
  if (entities.length > 0) {
    const lines = entities.map(({ row, scopeLevel }) => {
      const desc = row.description ? `: ${row.description}` : '';
      return `- ${row.name} (${row.entity_type})${scopeLabel(scopeLevel)}${desc}`;
    });
    sections.push(`## Known Entities\n${lines.join('\n')}`);
  }

  // Related Entities (1-hop graph expansion of the top entities). Traversal
  // already ran in parallel with hydration above; here we only look up
  // root names from the hydrated entity rows for rendering.
  if (neighborGroups.length > 0 && entities.length > 0) {
    const entityById = new Map<string, EntityRow>();
    for (const { row } of entities) entityById.set(row.id, row);

    const groupLines: string[] = [];
    for (const { rootId, neighbors } of neighborGroups) {
      const root = entityById.get(rootId);
      if (!root) continue;
      const items = neighbors
        .map((n) => `  - ${n.name} (${n.entity_type}, hop ${n.hop_distance})`)
        .join('\n');
      groupLines.push(`- ${root.name}:\n${items}`);
    }
    if (groupLines.length > 0) {
      sections.push(`## Related Entities\n${groupLines.join('\n')}`);
    }
  }

  // Preferences
  if (preferences.length > 0) {
    const lines = preferences.map(({ row, scopeLevel }) => {
      const ctx = row.context ? ` (context: ${row.context})` : '';
      return `- ${row.category}: ${row.preference}${scopeLabel(scopeLevel)}${ctx}`;
    });
    sections.push(`## Preferences\n${lines.join('\n')}`);
  }

  // Relevant Facts — hydrateFacts already filters expired at the SQL
  // boundary, so any row here is current.
  if (facts.length > 0) {
    const lines = facts.map(
      ({ row, scopeLevel }) => `- ${row.subject} ${row.predicate} ${row.object}${scopeLabel(scopeLevel)}`
    );
    sections.push(`## Relevant Facts\n${lines.join('\n')}`);
  }

  // Past Similar Tasks
  if (traces.length > 0) {
    const lines = traces.map(({ row }) => {
      const successLabel = row.success === 1 ? 'yes' : row.success === 0 ? 'no' : 'unknown';
      const durationLabel = row.duration_ms !== null ? `${row.duration_ms}ms` : 'n/a';
      const outcomeLabel = row.outcome ?? 'pending';
      return `- ${row.task} \u2192 ${outcomeLabel} (success: ${successLabel}, duration: ${durationLabel})`;
    });
    sections.push(`## Past Similar Tasks\n${lines.join('\n')}`);
  }

  return { context: sections.join('\n\n'), errors };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type SafeQuery = <T>(source: string, fn: () => Promise<T[]>) => Promise<T[]>;

/**
 * One-shot variant of safeQuery for non-array results (e.g. the shared
 * query embedding). Returns null on failure, logging + collecting the
 * error in the same shape as makeSafeQuery so callers can surface it.
 */
async function safeOnce<T>(
  source: string,
  errors: ContextError[],
  projectId: string,
  userId: string,
  fn: () => Promise<T>
): Promise<T | null> {
  try {
    return await fn();
  } catch (err: unknown) {
    const name = err instanceof Error ? err.constructor.name : 'UnknownError';
    const message = err instanceof Error ? err.message : String(err);
    logError('context_subquery_failed', err, {
      component: 'context',
      source,
      project_id: projectId,
      user_id: userId,
    });
    errors.push({ source, message: `${name}: ${message}` });
    return null;
  }
}

/**
 * Factory for a labelled safe-query wrapper. Failures are logged as
 * structured JSON (source, projectId, userId, error class, message) and
 * collected into the shared `errors` array so callers can surface partial
 * failures in their responses.
 */
function makeSafeQuery(
  errors: ContextError[],
  projectId: string,
  userId: string
): SafeQuery {
  return async function safe<T>(source: string, fn: () => Promise<T[]>): Promise<T[]> {
    try {
      return await fn();
    } catch (err: unknown) {
      const name = err instanceof Error ? err.constructor.name : 'UnknownError';
      const message = err instanceof Error ? err.message : String(err);
      logError('context_subquery_failed', err, {
        component: 'context',
        source,
        project_id: projectId,
        user_id: userId,
      });
      errors.push({ source, message: `${name}: ${message}` });
      return [];
    }
  };
}

/** Truncate a string to `maxLen` characters, appending an ellipsis if needed. */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen) + '...';
}

/**
 * Build a parameterised `WHERE id IN (?, ?, ...)` clause for a list of IDs.
 * Returns { placeholders, bindings } ready for a D1 query.
 */
function buildInClause(ids: string[]): { placeholders: string; bindings: string[] } {
  const placeholders = ids.map(() => '?').join(', ');
  return { placeholders, bindings: ids };
}

// -- Hydration helpers: SearchResult[] -> { row, score }[] ----------------

interface Hydrated<T> {
  row: T;
  score: number;
  scopeLevel?: number; // 0=project+user, 1=user, 2=project, 3=global
}

// Decorate cross-scope hits so a model consuming the context block can
// tell project-local fact "X" apart from a global trivia hit ranked into
// the same query. Empty for the most-specific (project+user) scope.
function scopeLabel(level?: number): string {
  switch (level) {
    case 1: return ' (user-scope)';
    case 2: return ' (project-scope)';
    case 3: return ' (global)';
    default: return '';
  }
}

async function hydrateMessages(
  env: Bindings,
  results: SearchResult[],
  safe: SafeQuery
): Promise<Hydrated<MessageRow>[]> {
  if (results.length === 0) return [];
  const { placeholders, bindings } = buildInClause(results.map((r) => r.id));
  const rows = await safe('hydrate_messages', async () => {
    const res = await env.DB.prepare(
      `SELECT * FROM messages WHERE vector_id IN (${placeholders})`
    )
      .bind(...bindings)
      .all<MessageRow>();
    return res.results;
  });
  return joinWithScores(rows, results, (row) => row.vector_id ?? row.id);
}

async function hydrateEntities(
  env: Bindings,
  results: SearchResult[],
  safe: SafeQuery
): Promise<Hydrated<EntityRow>[]> {
  if (results.length === 0) return [];
  const { placeholders, bindings } = buildInClause(results.map((r) => r.id));
  const rows = await safe('hydrate_entities', async () => {
    const res = await env.DB.prepare(
      `SELECT * FROM entities WHERE id IN (${placeholders})`
    )
      .bind(...bindings)
      .all<EntityRow>();
    return res.results;
  });
  return joinWithScores(rows, results, (row) => row.id);
}

async function hydratePreferences(
  env: Bindings,
  results: SearchResult[],
  safe: SafeQuery
): Promise<Hydrated<PreferenceRow>[]> {
  if (results.length === 0) return [];
  const { placeholders, bindings } = buildInClause(results.map((r) => r.id));
  const rows = await safe('hydrate_preferences', async () => {
    const res = await env.DB.prepare(
      `SELECT * FROM preferences WHERE id IN (${placeholders})`
    )
      .bind(...bindings)
      .all<PreferenceRow>();
    return res.results;
  });
  return joinWithScores(rows, results, (row) => row.id);
}

async function hydrateFacts(
  env: Bindings,
  results: SearchResult[],
  safe: SafeQuery
): Promise<Hydrated<FactRow>[]> {
  if (results.length === 0) return [];
  const { placeholders, bindings } = buildInClause(results.map((r) => r.id));
  const now = new Date().toISOString();
  // Defence in depth: searchFacts already drops expired hits, but
  // contextBuilder calls hydrateFacts on independently-cascaded results
  // too. Keep the temporal filter at the SQL boundary so no path leaks
  // expired facts into the formatted context.
  const rows = await safe('hydrate_facts', async () => {
    const res = await env.DB.prepare(
      `SELECT * FROM facts WHERE id IN (${placeholders}) AND (valid_until IS NULL OR valid_until > ?)`
    )
      .bind(...bindings, now)
      .all<FactRow>();
    return res.results;
  });
  return joinWithScores(rows, results, (row) => row.id);
}

async function hydrateTraces(
  env: Bindings,
  results: SearchResult[],
  safe: SafeQuery
): Promise<Hydrated<TraceRow>[]> {
  if (results.length === 0) return [];
  const { placeholders, bindings } = buildInClause(results.map((r) => r.id));
  const rows = await safe('hydrate_traces', async () => {
    const res = await env.DB.prepare(
      `SELECT * FROM reasoning_traces WHERE id IN (${placeholders})`
    )
      .bind(...bindings)
      .all<TraceRow>();
    return res.results;
  });
  return joinWithScores(rows, results, (row) => row.id);
}

interface NeighborGroup {
  rootId: string;
  neighbors: NeighborRow[];
}

/**
 * For each top entity id, fetch its 1-hop neighbors. Runs in parallel and
 * skips entities whose traversal returns nothing so the section only
 * appears when there's something to show. Operates on ids alone so it
 * can run concurrently with entity hydration.
 */
async function fetchNeighborGroupsByIds(
  env: Bindings,
  projectId: string,
  userId: string,
  rootIds: string[],
  safe: SafeQuery
): Promise<NeighborGroup[]> {
  if (rootIds.length === 0) return [];
  const groups = await Promise.all(
    rootIds.map(async (rootId) => {
      const neighbors = await safe('neighbor_traversal', () =>
        traverseRelations(env, rootId, projectId, userId, {
          maxDepth: 1,
          limit: GRAPH.contextNeighborsPerEntity,
        })
      );
      return { rootId, neighbors };
    })
  );
  return groups.filter((g) => g.neighbors.length > 0);
}

/**
 * Join hydrated D1 rows with their vector search scores, preserving the
 * original score-descending order.
 */
function joinWithScores<T>(
  rows: T[],
  results: SearchResult[],
  getKey: (row: T) => string
): Hydrated<T>[] {
  const meta = new Map<string, { score: number; scopeLevel?: number }>();
  for (const r of results) {
    meta.set(r.id, { score: r.score, scopeLevel: r.scopeLevel });
  }

  const hydrated: Hydrated<T>[] = [];
  for (const row of rows) {
    const key = getKey(row);
    const m = meta.get(key);
    if (m !== undefined) {
      hydrated.push({ row, score: m.score, scopeLevel: m.scopeLevel });
    }
  }

  // Sort by score descending to preserve ranking from vector search
  hydrated.sort((a, b) => b.score - a.score);
  return hydrated;
}
