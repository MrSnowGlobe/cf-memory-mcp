import type { Bindings, NeighborRow } from '../types';
import { GRAPH } from '../config';

export type TraversalDirection = 'out' | 'in' | 'both';

export interface TraverseOptions {
  /** How many hops to walk. Capped at GRAPH.hardMaxDepth. Default GRAPH.defaultMaxDepth. */
  maxDepth?: number;
  /** Restrict edges to these relation_types. Empty/omitted = no filter. */
  relationTypes?: string[];
  /** Edge direction relative to root. Default 'both' (treat graph as undirected). */
  direction?: TraversalDirection;
  /** Max entities returned. Default GRAPH.defaultLimit. */
  limit?: number;
}

/**
 * Multi-hop graph traversal over entity_relations.
 *
 * Uses a SQLite recursive CTE to walk outward from `rootId`, returning
 * each reachable entity once with its minimum hop distance. Scope rules
 * mirror entity resolution: project + global, user + global + default.
 *
 * Relation_type and direction filters are applied during the recursion,
 * so they prune branches early rather than after the fact.
 *
 * The hardMaxDepth cap and LIMIT bound worst-case row counts. For typical
 * memory graphs (1k–100k edges per project) and depth ≤ 3 this stays in
 * the low single-digit ms on D1.
 */
export async function traverseRelations(
  env: Bindings,
  rootId: string,
  projectId: string,
  userId: string,
  opts: TraverseOptions = {}
): Promise<NeighborRow[]> {
  const requestedDepth = opts.maxDepth ?? GRAPH.defaultMaxDepth;
  const maxDepth = Math.min(Math.max(requestedDepth, 1), GRAPH.hardMaxDepth);
  const limit = opts.limit ?? GRAPH.defaultLimit;
  const direction: TraversalDirection = opts.direction ?? 'both';
  const relationTypes = opts.relationTypes ?? [];

  // Build the directional join predicate and the "next entity" expression.
  let joinPredicate: string;
  let nextEntityExpr: string;
  switch (direction) {
    case 'out':
      joinPredicate = 'er.source_entity_id = r.entity_id';
      nextEntityExpr = 'er.target_entity_id';
      break;
    case 'in':
      joinPredicate = 'er.target_entity_id = r.entity_id';
      nextEntityExpr = 'er.source_entity_id';
      break;
    case 'both':
      joinPredicate = '(er.source_entity_id = r.entity_id OR er.target_entity_id = r.entity_id)';
      nextEntityExpr =
        'CASE WHEN er.source_entity_id = r.entity_id THEN er.target_entity_id ELSE er.source_entity_id END';
      break;
  }

  // Optional relation_type filter applied inside the recursion.
  const typeBindings: string[] = [];
  let typeFilter = '';
  if (relationTypes.length > 0) {
    const placeholders = relationTypes.map(() => '?').join(', ');
    typeFilter = ` AND er.relation_type IN (${placeholders})`;
    typeBindings.push(...relationTypes);
  }

  const sql = `
    WITH RECURSIVE reachable(entity_id, depth) AS (
      SELECT ? AS entity_id, 0 AS depth
      UNION
      SELECT
        ${nextEntityExpr} AS entity_id,
        r.depth + 1 AS depth
      FROM reachable r
      JOIN entity_relations er ON ${joinPredicate}
      WHERE r.depth < ?${typeFilter}
    )
    SELECT
      e.id, e.project_id, e.user_id, e.name, e.entity_type, e.subtype,
      e.description, e.promoted_from, e.metadata, e.created_at, e.updated_at, e.vector_id,
      MIN(r.depth) AS hop_distance
    FROM reachable r
    JOIN entities e ON e.id = r.entity_id
    WHERE r.entity_id != ?
      AND e.project_id IN (?, 'global')
      AND e.user_id IN (?, 'global', 'default')
    GROUP BY e.id
    ORDER BY hop_distance ASC, e.updated_at DESC
    LIMIT ?
  `;

  // Binding order: anchor rootId, maxDepth, [relation_types...], rootId (for !=),
  // projectId, userId, limit.
  const result = await env.DB.prepare(sql)
    .bind(rootId, maxDepth, ...typeBindings, rootId, projectId, userId, limit)
    .all<NeighborRow>();

  return result.results;
}
