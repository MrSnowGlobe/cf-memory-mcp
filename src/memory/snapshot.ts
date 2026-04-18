import type {
  Bindings,
  EntityRow,
  RelationRow,
  TraceRow,
  PreferenceRow,
  FactRow,
} from '../types';

/** Subset of MessageRow with the parent session_id always present. */
export interface SnapshotMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  created_at: string;
}

export interface GraphSnapshotStats {
  entities: number;
  relations: number;
  preferences: number;
  facts: number;
  sessions: number;
  messages: number;
  traces: number;
}

export interface GraphSnapshot {
  scope: { project_id: string; user_id: string };
  stats: GraphSnapshotStats;
  entities: EntityRow[];
  relations: RelationRow[];
  recent_messages: SnapshotMessage[];
  recent_traces: TraceRow[];
  recent_preferences: PreferenceRow[];
  recent_facts: FactRow[];
}

export interface SnapshotOptions {
  /** Max entities to return. Hard cap 500. Default 200. */
  entityLimit?: number;
  /** Max relations to return. Hard cap 1000. Default 500. */
  relationLimit?: number;
  /** Max recent messages. Hard cap 100. Default 20. */
  messageLimit?: number;
  /** Max recent traces. Hard cap 100. Default 20. */
  traceLimit?: number;
  /** Max recent preferences. Hard cap 100. Default 15. */
  preferenceLimit?: number;
  /** Max recent (non-expired) facts. Hard cap 100. Default 15. */
  factLimit?: number;
}

/**
 * Single read-only snapshot for the visualizer. Pulls everything in one
 * batch so the UI can bootstrap with one network call.
 *
 * Scope rules mirror cascadingSearch / resolveEntity: project + global,
 * user + global + default. Relations are returned only when BOTH endpoints
 * are in the visible scope so the graph never points at hidden nodes.
 */
export async function getGraphSnapshot(
  env: Bindings,
  projectId: string,
  userId: string,
  opts: SnapshotOptions = {}
): Promise<GraphSnapshot> {
  const entityLimit = clamp(opts.entityLimit ?? 200, 1, 500);
  const relationLimit = clamp(opts.relationLimit ?? 500, 1, 1000);
  const messageLimit = clamp(opts.messageLimit ?? 20, 1, 100);
  const traceLimit = clamp(opts.traceLimit ?? 20, 1, 100);
  const preferenceLimit = clamp(opts.preferenceLimit ?? 15, 1, 100);
  const factLimit = clamp(opts.factLimit ?? 15, 1, 100);
  const nowIso = new Date().toISOString();

  const [
    entitiesRes,
    relationsRes,
    messagesRes,
    tracesRes,
    preferencesRes,
    factsRes,
    countsRes,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM entities
       WHERE project_id IN (?, 'global')
         AND user_id IN (?, 'global', 'default')
       ORDER BY updated_at DESC
       LIMIT ?`
    )
      .bind(projectId, userId, entityLimit)
      .all<EntityRow>(),

    env.DB.prepare(
      `SELECT er.*
       FROM entity_relations er
       JOIN entities src ON src.id = er.source_entity_id
       JOIN entities tgt ON tgt.id = er.target_entity_id
       WHERE src.project_id IN (?, 'global')
         AND src.user_id IN (?, 'global', 'default')
         AND tgt.project_id IN (?, 'global')
         AND tgt.user_id IN (?, 'global', 'default')
       ORDER BY er.created_at DESC
       LIMIT ?`
    )
      .bind(projectId, userId, projectId, userId, relationLimit)
      .all<RelationRow>(),

    env.DB.prepare(
      `SELECT m.id, m.session_id, m.role, m.content, m.created_at
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE s.project_id IN (?, 'global')
         AND s.user_id IN (?, 'global', 'default')
       ORDER BY m.created_at DESC
       LIMIT ?`
    )
      .bind(projectId, userId, messageLimit)
      .all<SnapshotMessage>(),

    env.DB.prepare(
      `SELECT * FROM reasoning_traces
       WHERE project_id IN (?, 'global')
         AND user_id IN (?, 'global', 'default')
       ORDER BY started_at DESC
       LIMIT ?`
    )
      .bind(projectId, userId, traceLimit)
      .all<TraceRow>(),

    env.DB.prepare(
      `SELECT * FROM preferences
       WHERE project_id IN (?, 'global')
         AND user_id IN (?, 'global', 'default')
       ORDER BY updated_at DESC
       LIMIT ?`
    )
      .bind(projectId, userId, preferenceLimit)
      .all<PreferenceRow>(),

    env.DB.prepare(
      `SELECT * FROM facts
       WHERE project_id IN (?, 'global')
         AND user_id IN (?, 'global', 'default')
         AND (valid_until IS NULL OR valid_until > ?)
       ORDER BY created_at DESC
       LIMIT ?`
    )
      .bind(projectId, userId, nowIso, factLimit)
      .all<FactRow>(),

    // Single-row aggregate of every count we care about. Cheaper than
    // five round-trips because D1 batches the subqueries server-side.
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM entities WHERE project_id IN (?, 'global') AND user_id IN (?, 'global', 'default')) AS entities,
         (SELECT COUNT(*) FROM entity_relations er
            JOIN entities src ON src.id = er.source_entity_id
            JOIN entities tgt ON tgt.id = er.target_entity_id
            WHERE src.project_id IN (?, 'global') AND src.user_id IN (?, 'global', 'default')
              AND tgt.project_id IN (?, 'global') AND tgt.user_id IN (?, 'global', 'default')) AS relations,
         (SELECT COUNT(*) FROM preferences WHERE project_id IN (?, 'global') AND user_id IN (?, 'global', 'default')) AS preferences,
         (SELECT COUNT(*) FROM facts WHERE project_id IN (?, 'global') AND user_id IN (?, 'global', 'default')
            AND (valid_until IS NULL OR valid_until > ?)) AS facts,
         (SELECT COUNT(*) FROM sessions WHERE project_id IN (?, 'global') AND user_id IN (?, 'global', 'default')) AS sessions,
         (SELECT COUNT(*) FROM messages m
            JOIN sessions s ON s.id = m.session_id
            WHERE s.project_id IN (?, 'global') AND s.user_id IN (?, 'global', 'default')) AS messages,
         (SELECT COUNT(*) FROM reasoning_traces WHERE project_id IN (?, 'global') AND user_id IN (?, 'global', 'default')) AS traces`
    )
      .bind(
        projectId, userId,                                 // entities
        projectId, userId, projectId, userId,              // relations
        projectId, userId,                                 // preferences
        projectId, userId, nowIso,                         // facts
        projectId, userId,                                 // sessions
        projectId, userId,                                 // messages
        projectId, userId                                  // traces
      )
      .first<GraphSnapshotStats>(),
  ]);

  const stats: GraphSnapshotStats = countsRes ?? {
    entities: 0,
    relations: 0,
    preferences: 0,
    facts: 0,
    sessions: 0,
    messages: 0,
    traces: 0,
  };

  return {
    scope: { project_id: projectId, user_id: userId },
    stats,
    entities: entitiesRes.results,
    relations: relationsRes.results,
    recent_messages: messagesRes.results,
    recent_traces: tracesRes.results,
    recent_preferences: preferencesRes.results,
    recent_facts: factsRes.results,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
