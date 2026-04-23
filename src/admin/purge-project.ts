import type { Bindings } from '../types';
import { forgetProject } from '../middleware/project-scope';

/**
 * Detail of what a single purge run deleted. Useful for test-run post-mortems
 * and to confirm the resulting state at a glance.
 */
export interface PurgeResult {
  projectId: string;
  d1: {
    sessions: number;
    messages: number;
    entities: number;
    entity_relations: number;
    preferences: number;
    facts: number;
    reasoning_traces: number;
    reasoning_steps: number;
    tool_calls: number;
    tool_stats: number;
    promotion_log: number;
    projects: number;
  };
  vectors: {
    messages: number;
    entities: number;
    preferences: number;
    facts: number;
    traces: number;
  };
  kv: {
    keys_deleted: number;
  };
  errors: string[];
  duration_ms: number;
}

const VECTORIZE_BATCH = 1000;

async function collectVectorIds(
  env: Bindings,
  sql: string,
  projectId: string
): Promise<string[]> {
  const { results } = await env.DB.prepare(sql)
    .bind(projectId)
    .all<{ vector_id: string | null }>();
  return results
    .map((r) => r.vector_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

async function deleteVectorsInBatches(
  index: VectorizeIndex,
  ids: string[],
  errors: string[],
  label: string
): Promise<number> {
  if (ids.length === 0) return 0;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += VECTORIZE_BATCH) {
    const chunk = ids.slice(i, i + VECTORIZE_BATCH);
    try {
      await index.deleteByIds(chunk);
      deleted += chunk.length;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`vectorize:${label}: ${msg}`);
    }
  }
  return deleted;
}

async function countRows(
  env: Bindings,
  sql: string,
  projectId: string
): Promise<number> {
  const row = await env.DB.prepare(sql).bind(projectId).first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * Hard-purge every row, vector, and cache entry belonging to a project.
 * Designed for post-stress-test cleanup. Refuses reserved projects.
 *
 * Order of operations:
 *   1. Collect vector_ids from D1 (so we know what to tell Vectorize).
 *   2. Count descendant rows that will be cascade-deleted (messages,
 *      entity_relations, reasoning_steps, tool_calls) for reporting.
 *   3. Delete vectors via `deleteByIds` in 1000-id batches.
 *   4. Delete D1 rows — FK cascades handle children.
 *   5. List + delete KV keys under the `{projectId}:` prefix.
 *   6. Optionally drop the `projects` row (default: keep it so the
 *      project ID can be reused without re-registering).
 */
export async function purgeProject(
  env: Bindings,
  projectId: string,
  options: { deleteProject?: boolean } = {}
): Promise<PurgeResult> {
  const startedAt = Date.now();
  const errors: string[] = [];

  if (projectId === 'default' || projectId === 'global') {
    throw new Error(`Cannot purge reserved project '${projectId}'`);
  }

  // 1 — collect vector IDs while D1 still has them
  const [msgVecIds, entVecIds, prefVecIds, factVecIds, traceVecIds] =
    await Promise.all([
      collectVectorIds(
        env,
        `SELECT m.vector_id FROM messages m
         JOIN sessions s ON m.session_id = s.id
         WHERE s.project_id = ? AND m.vector_id IS NOT NULL`,
        projectId
      ),
      collectVectorIds(
        env,
        `SELECT vector_id FROM entities
         WHERE project_id = ? AND vector_id IS NOT NULL`,
        projectId
      ),
      collectVectorIds(
        env,
        `SELECT vector_id FROM preferences
         WHERE project_id = ? AND vector_id IS NOT NULL`,
        projectId
      ),
      collectVectorIds(
        env,
        `SELECT vector_id FROM facts
         WHERE project_id = ? AND vector_id IS NOT NULL`,
        projectId
      ),
      collectVectorIds(
        env,
        `SELECT vector_id FROM reasoning_traces
         WHERE project_id = ? AND vector_id IS NOT NULL`,
        projectId
      ),
    ]);

  // 2 — count descendants before cascades wipe them
  const [messagesCount, entityRelationsCount, stepsCount, toolCallsCount] =
    await Promise.all([
      countRows(
        env,
        `SELECT COUNT(*) AS c FROM messages m
         JOIN sessions s ON m.session_id = s.id
         WHERE s.project_id = ?`,
        projectId
      ),
      countRows(
        env,
        `SELECT COUNT(*) AS c FROM entity_relations er
         JOIN entities e ON er.source_entity_id = e.id
         WHERE e.project_id = ?`,
        projectId
      ),
      countRows(
        env,
        `SELECT COUNT(*) AS c FROM reasoning_steps rs
         JOIN reasoning_traces rt ON rs.trace_id = rt.id
         WHERE rt.project_id = ?`,
        projectId
      ),
      countRows(
        env,
        `SELECT COUNT(*) AS c FROM tool_calls tc
         JOIN reasoning_steps rs ON tc.step_id = rs.id
         JOIN reasoning_traces rt ON rs.trace_id = rt.id
         WHERE rt.project_id = ?`,
        projectId
      ),
    ]);

  // 3 — delete vectors first. If Vectorize fails, we still continue to
  // D1/KV delete — leaving orphaned vectors is recoverable; the opposite
  // (dangling D1 rows pointing at deleted vectors) is worse because the
  // search paths still try to hydrate them.
  const vectors = {
    messages: await deleteVectorsInBatches(
      env.VEC_MESSAGES,
      msgVecIds,
      errors,
      'messages'
    ),
    entities: await deleteVectorsInBatches(
      env.VEC_ENTITIES,
      entVecIds,
      errors,
      'entities'
    ),
    preferences: await deleteVectorsInBatches(
      env.VEC_PREFERENCES,
      prefVecIds,
      errors,
      'preferences'
    ),
    facts: await deleteVectorsInBatches(
      env.VEC_FACTS,
      factVecIds,
      errors,
      'facts'
    ),
    traces: await deleteVectorsInBatches(
      env.VEC_TRACES,
      traceVecIds,
      errors,
      'traces'
    ),
  };

  // 4 — delete D1 rows. Order matters only where FKs point at peer tables;
  // within a single project_id, cascades take care of descendants.
  const sessionsDeleted = await countRows(
    env,
    'SELECT COUNT(*) AS c FROM sessions WHERE project_id = ?',
    projectId
  );
  const entitiesDeleted = await countRows(
    env,
    'SELECT COUNT(*) AS c FROM entities WHERE project_id = ?',
    projectId
  );
  const preferencesDeleted = await countRows(
    env,
    'SELECT COUNT(*) AS c FROM preferences WHERE project_id = ?',
    projectId
  );
  const factsDeleted = await countRows(
    env,
    'SELECT COUNT(*) AS c FROM facts WHERE project_id = ?',
    projectId
  );
  const tracesDeleted = await countRows(
    env,
    'SELECT COUNT(*) AS c FROM reasoning_traces WHERE project_id = ?',
    projectId
  );
  const toolStatsDeleted = await countRows(
    env,
    'SELECT COUNT(*) AS c FROM tool_stats WHERE project_id = ?',
    projectId
  );
  const promotionLogDeleted = await countRows(
    env,
    'SELECT COUNT(*) AS c FROM promotion_log WHERE source_project_id = ?',
    projectId
  );

  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE project_id = ?').bind(projectId),
    env.DB.prepare('DELETE FROM entities WHERE project_id = ?').bind(projectId),
    env.DB.prepare('DELETE FROM preferences WHERE project_id = ?').bind(projectId),
    env.DB.prepare('DELETE FROM facts WHERE project_id = ?').bind(projectId),
    env.DB.prepare('DELETE FROM reasoning_traces WHERE project_id = ?').bind(projectId),
    env.DB.prepare('DELETE FROM tool_stats WHERE project_id = ?').bind(projectId),
    env.DB.prepare('DELETE FROM promotion_log WHERE source_project_id = ?').bind(projectId),
  ]);

  // 5 — KV. Prefix is `{projectId}:` per services/cache.ts convention.
  let kvDeleted = 0;
  let cursor: string | undefined;
  try {
    do {
      const listOpts: KVNamespaceListOptions = { prefix: `${projectId}:` };
      if (cursor) listOpts.cursor = cursor;
      const page = await env.CACHE.list(listOpts);
      await Promise.all(page.keys.map((k) => env.CACHE.delete(k.name)));
      kvDeleted += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`kv: ${msg}`);
  }

  // 6 — optionally drop the project row itself
  let projectsDeleted = 0;
  if (options.deleteProject) {
    await env.DB.prepare('DELETE FROM projects WHERE id = ?')
      .bind(projectId)
      .run();
    projectsDeleted = 1;
    forgetProject(projectId);
  }

  return {
    projectId,
    d1: {
      sessions: sessionsDeleted,
      messages: messagesCount,
      entities: entitiesDeleted,
      entity_relations: entityRelationsCount,
      preferences: preferencesDeleted,
      facts: factsDeleted,
      reasoning_traces: tracesDeleted,
      reasoning_steps: stepsCount,
      tool_calls: toolCallsCount,
      tool_stats: toolStatsDeleted,
      promotion_log: promotionLogDeleted,
      projects: projectsDeleted,
    },
    vectors,
    kv: { keys_deleted: kvDeleted },
    errors,
    duration_ms: Date.now() - startedAt,
  };
}
