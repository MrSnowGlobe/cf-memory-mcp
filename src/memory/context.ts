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
import { traverseRelations } from '../services/graph';
import { GRAPH } from '../config';

/** Default limits for each memory section when not specified by caller. */
const DEFAULT_LIMITS = {
  messages: 10,
  entities: 5,
  preferences: 5,
  facts: 5,
  traces: 3,
} as const;

/**
 * Builds a unified context string by querying all three memory subsystems
 * in parallel and formatting the results into a structured text block.
 *
 * This is a plain function (not a class) per project conventions.
 */
export async function buildContext(
  env: Bindings,
  projectId: string,
  userId: string,
  input: ContextInput
): Promise<string> {
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

  // ------------------------------------------------------------------
  // 1. Fire all queries in parallel
  // ------------------------------------------------------------------
  type MaybeMessages = MessageRow[];
  type MaybeSearchResults = SearchResult[];

  const conversationPromise: Promise<MaybeMessages> =
    include.includes('short_term') && input.session_id
      ? safeQuery(() => shortTerm.getConversation(input.session_id!, limits.messages))
      : Promise.resolve([]);

  const messageSearchPromise: Promise<MaybeSearchResults> =
    include.includes('short_term')
      ? safeQuery(() => shortTerm.searchMessages(input.query, { limit: limits.messages }))
      : Promise.resolve([]);

  const entitySearchPromise: Promise<MaybeSearchResults> =
    include.includes('long_term')
      ? safeQuery(() => longTerm.searchEntities(input.query, limits.entities))
      : Promise.resolve([]);

  const preferenceSearchPromise: Promise<MaybeSearchResults> =
    include.includes('long_term')
      ? safeQuery(() => longTerm.searchPreferences(input.query, limits.preferences))
      : Promise.resolve([]);

  const factSearchPromise: Promise<MaybeSearchResults> =
    include.includes('long_term')
      ? safeQuery(() => longTerm.searchFacts(input.query, limits.facts))
      : Promise.resolve([]);

  const traceSearchPromise: Promise<MaybeSearchResults> =
    include.includes('procedural')
      ? safeQuery(() => procedural.searchTraces(input.query, limits.traces))
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
  // 2. Hydrate search results by looking up full D1 rows
  // ------------------------------------------------------------------
  const [messages, entities, preferences, facts, traces] = await Promise.all([
    hydrateMessages(env, messageResults),
    hydrateEntities(env, entityResults),
    hydratePreferences(env, preferenceResults),
    hydrateFacts(env, factResults),
    hydrateTraces(env, traceResults),
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
    const lines = entities.map(({ row }) => {
      const desc = row.description ? `: ${row.description}` : '';
      return `- ${row.name} (${row.entity_type})${desc}`;
    });
    sections.push(`## Known Entities\n${lines.join('\n')}`);
  }

  // Related Entities (1-hop graph expansion of the top entities)
  if (entities.length > 0 && include.includes('long_term')) {
    const topEntities = entities
      .slice(0, GRAPH.contextEntitiesToExpand)
      .map(({ row }) => row);
    const neighborGroups = await fetchNeighborGroups(env, projectId, userId, topEntities);
    if (neighborGroups.length > 0) {
      const groupLines = neighborGroups.map(({ root, neighbors }) => {
        const items = neighbors
          .map((n) => `  - ${n.name} (${n.entity_type}, hop ${n.hop_distance})`)
          .join('\n');
        return `- ${root.name}:\n${items}`;
      });
      sections.push(`## Related Entities\n${groupLines.join('\n')}`);
    }
  }

  // Preferences
  if (preferences.length > 0) {
    const lines = preferences.map(({ row }) => {
      const ctx = row.context ? ` (context: ${row.context})` : '';
      return `- ${row.category}: ${row.preference}${ctx}`;
    });
    sections.push(`## Preferences\n${lines.join('\n')}`);
  }

  // Relevant Facts (exclude expired)
  const now = new Date().toISOString();
  const activeFacts = facts.filter(
    ({ row }) => !row.valid_until || row.valid_until > now
  );
  if (activeFacts.length > 0) {
    const lines = activeFacts.map(
      ({ row }) => `- ${row.subject} ${row.predicate} ${row.object}`
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

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Wraps a query function so it never throws. If it fails, an empty array
 * is returned and the error is silently consumed (logged via console.error
 * which Workers captures).
 */
async function safeQuery<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (err: unknown) {
    console.error('[context] query failed:', err);
    return [];
  }
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
}

async function hydrateMessages(
  env: Bindings,
  results: SearchResult[]
): Promise<Hydrated<MessageRow>[]> {
  if (results.length === 0) return [];
  const { placeholders, bindings } = buildInClause(results.map((r) => r.id));
  const rows = await safeQuery(async () => {
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
  results: SearchResult[]
): Promise<Hydrated<EntityRow>[]> {
  if (results.length === 0) return [];
  const { placeholders, bindings } = buildInClause(results.map((r) => r.id));
  const rows = await safeQuery(async () => {
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
  results: SearchResult[]
): Promise<Hydrated<PreferenceRow>[]> {
  if (results.length === 0) return [];
  const { placeholders, bindings } = buildInClause(results.map((r) => r.id));
  const rows = await safeQuery(async () => {
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
  results: SearchResult[]
): Promise<Hydrated<FactRow>[]> {
  if (results.length === 0) return [];
  const { placeholders, bindings } = buildInClause(results.map((r) => r.id));
  const rows = await safeQuery(async () => {
    const res = await env.DB.prepare(
      `SELECT * FROM facts WHERE id IN (${placeholders})`
    )
      .bind(...bindings)
      .all<FactRow>();
    return res.results;
  });
  return joinWithScores(rows, results, (row) => row.id);
}

async function hydrateTraces(
  env: Bindings,
  results: SearchResult[]
): Promise<Hydrated<TraceRow>[]> {
  if (results.length === 0) return [];
  const { placeholders, bindings } = buildInClause(results.map((r) => r.id));
  const rows = await safeQuery(async () => {
    const res = await env.DB.prepare(
      `SELECT * FROM reasoning_traces WHERE id IN (${placeholders})`
    )
      .bind(...bindings)
      .all<TraceRow>();
    return res.results;
  });
  return joinWithScores(rows, results, (row) => row.id);
}

/**
 * For each top entity, fetch its 1-hop neighbors. Runs in parallel and
 * skips entities whose traversal returns nothing so the section only
 * appears when there's something to show.
 */
async function fetchNeighborGroups(
  env: Bindings,
  projectId: string,
  userId: string,
  roots: EntityRow[]
): Promise<Array<{ root: EntityRow; neighbors: NeighborRow[] }>> {
  if (roots.length === 0) return [];
  const groups = await Promise.all(
    roots.map(async (root) => {
      const neighbors = await safeQuery(() =>
        traverseRelations(env, root.id, projectId, userId, {
          maxDepth: 1,
          limit: GRAPH.contextNeighborsPerEntity,
        })
      );
      return { root, neighbors };
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
  const scoreMap = new Map<string, number>();
  for (const r of results) {
    scoreMap.set(r.id, r.score);
  }

  const hydrated: Hydrated<T>[] = [];
  for (const row of rows) {
    const key = getKey(row);
    const score = scoreMap.get(key);
    if (score !== undefined) {
      hydrated.push({ row, score });
    }
  }

  // Sort by score descending to preserve ranking from vector search
  hydrated.sort((a, b) => b.score - a.score);
  return hydrated;
}
