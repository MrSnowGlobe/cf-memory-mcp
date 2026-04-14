import type { SearchResult } from '../types';

/**
 * Compute the most-specific write namespace for a given project+user pair.
 * Mirrors the tier logic in cascadingSearch so that data written at the
 * "most specific" scope is always found by a cascading read.
 */
export function getWriteNamespace(projectId: string, userId: string): string {
  const hasUser = userId !== 'default' && userId !== 'global';
  const hasProject = projectId !== 'global';

  if (hasProject && hasUser) return `${projectId}:${userId}`;
  if (hasProject) return projectId;
  if (hasUser) return `user:${userId}`;
  return 'global';
}

/**
 * Insert a vector into a project-namespaced index.
 */
export async function vectorInsert(
  index: VectorizeIndex,
  id: string,
  values: number[],
  namespace: string,
  metadata?: Record<string, string>
): Promise<void> {
  await index.insert([{ id, values, namespace, metadata }]);
}

/**
 * Delete vectors by ID.
 */
export async function vectorDelete(
  index: VectorizeIndex,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  await index.deleteByIds(ids);
}

export interface CascadeOpts {
  preferenceDedup?: boolean;
}

/**
 * 4-tier cascading search: project+user → user → project → global.
 *
 * Fires queries in parallel, boosts narrower scopes higher, merges and deduplicates.
 * When preferenceDedup is true, applies strict scope precedence per category.
 */
export async function cascadingSearch(
  index: VectorizeIndex,
  queryEmbedding: number[],
  projectId: string,
  userId: string,
  topK: number = 10,
  opts?: CascadeOpts
): Promise<SearchResult[]> {
  // Build tier list based on scope specificity
  const tiers: Array<{ namespace: string; boost: number; scopeLevel: number; topK: number }> = [];

  const hasUser = userId !== 'default' && userId !== 'global';
  const hasProject = projectId !== 'global';

  if (hasProject && hasUser) {
    // Full 4-tier cascade
    tiers.push({ namespace: `${projectId}:${userId}`, boost: 0.15, scopeLevel: 0, topK });
    tiers.push({ namespace: `user:${userId}`, boost: 0.10, scopeLevel: 1, topK });
    tiers.push({ namespace: projectId, boost: 0.05, scopeLevel: 2, topK: Math.ceil(topK / 2) });
    tiers.push({ namespace: 'global', boost: 0.0, scopeLevel: 3, topK: Math.ceil(topK / 2) });
  } else if (hasProject) {
    // Project + global (no specific user)
    tiers.push({ namespace: projectId, boost: 0.05, scopeLevel: 2, topK });
    tiers.push({ namespace: 'global', boost: 0.0, scopeLevel: 3, topK: Math.ceil(topK / 2) });
  } else if (hasUser) {
    // User + global (no specific project)
    tiers.push({ namespace: `user:${userId}`, boost: 0.10, scopeLevel: 1, topK });
    tiers.push({ namespace: 'global', boost: 0.0, scopeLevel: 3, topK: Math.ceil(topK / 2) });
  } else {
    // Global only
    tiers.push({ namespace: 'global', boost: 0.0, scopeLevel: 3, topK });
  }

  // Fire all queries in parallel
  const tierResults = await Promise.all(
    tiers.map(async (tier) => {
      const results = await index.query(queryEmbedding, {
        topK: tier.topK,
        namespace: tier.namespace,
        returnMetadata: 'all',
      });
      return { tier, matches: results.matches ?? [] };
    })
  );

  // Merge and deduplicate by ID (keep highest score)
  const seen = new Map<string, SearchResult>();
  for (const { tier, matches } of tierResults) {
    for (const m of matches) {
      const result: SearchResult = {
        id: m.id,
        score: m.score + tier.boost,
        metadata: flattenMetadata(m.metadata),
        scopeLevel: tier.scopeLevel,
      };
      const existing = seen.get(m.id);
      if (!existing || result.score > existing.score) {
        seen.set(m.id, result);
      }
    }
  }

  let merged = Array.from(seen.values());

  // Strict scope precedence for preferences
  if (opts?.preferenceDedup) {
    merged = applyScopePrecedence(merged);
  }

  return merged.sort((a, b) => b.score - a.score).slice(0, topK);
}

/**
 * Strict scope precedence: for each preference category, keep only results
 * from the narrowest scope level. A project+user preference (level 0) suppresses
 * user-wide (1), project-wide (2), and global (3) results in the same category.
 */
function applyScopePrecedence(results: SearchResult[]): SearchResult[] {
  const byCategory = new Map<string, SearchResult[]>();
  const uncategorized: SearchResult[] = [];

  for (const r of results) {
    const category = r.metadata?.category;
    if (category) {
      const group = byCategory.get(category) ?? [];
      group.push(r);
      byCategory.set(category, group);
    } else {
      uncategorized.push(r);
    }
  }

  const deduplicated: SearchResult[] = [...uncategorized];
  for (const [, group] of byCategory) {
    const minScope = Math.min(...group.map((r) => r.scopeLevel ?? 3));
    deduplicated.push(...group.filter((r) => (r.scopeLevel ?? 3) === minScope));
  }

  return deduplicated;
}

/**
 * Flatten Vectorize match metadata into Record<string, string>.
 */
function flattenMetadata(
  meta: VectorizeMatch['metadata']
): Record<string, string> | undefined {
  if (!meta) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    result[key] = String(value);
  }
  return result;
}
