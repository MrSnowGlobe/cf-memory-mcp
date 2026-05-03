import type { Bindings, EntityRow } from '../types';
import { getEmbedding } from './embeddings';
import { cascadingSearch } from './vectorize';
import { RESOLUTION } from '../config';
import { distance } from 'fastest-levenshtein';

/**
 * Compute a fuzzy match score between two strings (0–1 similarity).
 * Uses Levenshtein distance normalized by the longer string's length.
 */
export function fuzzyMatch(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1 - distance(a.toLowerCase(), b.toLowerCase()) / maxLen;
}

/**
 * Compute a scope priority for a record (lower = narrower/preferred).
 * 0 = project+user, 1 = user-wide, 2 = project-wide, 3 = global
 */
function scopePriority(
  row: EntityRow,
  projectId: string,
  userId: string
): number {
  const isProject = row.project_id === projectId;
  const isUser = row.user_id === userId;
  if (isProject && isUser) return 0;
  if (!isProject && isUser) return 1;
  if (isProject && !isUser) return 2;
  return 3;
}

/**
 * Full entity resolution pipeline: exact → fuzzy → semantic.
 *
 * Searches project+user, user-wide, project-wide, and global scopes,
 * preferring narrower-scoped matches.
 */
export async function resolveEntity(
  env: Bindings,
  name: string,
  entityType: string,
  projectId: string,
  userId: string
): Promise<EntityRow | null> {
  // Stage 1 — Exact match in D1
  const exactMatch = await env.DB.prepare(
    `SELECT * FROM entities
     WHERE LOWER(name) = LOWER(?) AND entity_type = ?
     AND project_id IN (?, 'global')
     AND user_id IN (?, 'global', 'default')
     ORDER BY
       CASE
         WHEN project_id = ? AND user_id = ? THEN 0
         WHEN project_id != ? AND user_id = ? THEN 1
         WHEN project_id = ? AND user_id != ? THEN 2
         ELSE 3
       END
     LIMIT 1`
  )
    .bind(name, entityType, projectId, userId, projectId, userId, projectId, userId, projectId, userId)
    .first<EntityRow>();

  if (exactMatch) {
    return exactMatch;
  }

  // Stage 2 — Fuzzy match (bounded by config; prefer recent updates when truncated)
  const candidates = await env.DB.prepare(
    `SELECT * FROM entities
     WHERE entity_type = ? AND project_id IN (?, 'global')
     AND user_id IN (?, 'global', 'default')
     ORDER BY updated_at DESC
     LIMIT ?`
  )
    .bind(entityType, projectId, userId, RESOLUTION.fuzzyCandidateLimit)
    .all<EntityRow>();

  // Cheap prefilter: a Levenshtein similarity >= threshold requires the two
  // strings to differ in length by at most (1 - threshold) * max(len). Skipping
  // candidates that fail this bound avoids the per-character distance loop on
  // names that can't possibly match.
  const queryLen = name.length;
  const maxLenDiffRatio = 1 - RESOLUTION.fuzzyThreshold;

  let bestFuzzy: EntityRow | null = null;
  let bestFuzzyScore = 0;
  let bestFuzzyPriority = 4;

  for (const candidate of candidates.results) {
    const candLen = candidate.name.length;
    const lenMax = Math.max(queryLen, candLen);
    if (lenMax === 0) continue;
    if (Math.abs(queryLen - candLen) / lenMax > maxLenDiffRatio) continue;

    const score = fuzzyMatch(name, candidate.name);
    if (score >= RESOLUTION.fuzzyThreshold) {
      const priority = scopePriority(candidate, projectId, userId);

      if (
        score > bestFuzzyScore ||
        (score === bestFuzzyScore && priority < bestFuzzyPriority)
      ) {
        bestFuzzy = candidate;
        bestFuzzyScore = score;
        bestFuzzyPriority = priority;
      }
    }
  }

  if (bestFuzzy) {
    return bestFuzzy;
  }

  // Stage 3 — Semantic match via Vectorize
  const embedding = await getEmbedding(name, env.AI);
  const searchResults = await cascadingSearch(
    env.VEC_ENTITIES,
    embedding,
    projectId,
    userId,
    1
  );

  const topResult = searchResults[0];
  if (topResult && topResult.score >= RESOLUTION.semanticThreshold) {
    const entity = await env.DB.prepare(
      `SELECT * FROM entities WHERE id = ?`
    )
      .bind(topResult.id)
      .first<EntityRow>();

    if (entity) {
      return entity;
    }
  }

  // No match found at any stage
  return null;
}
