import type { Bindings } from '../types';
import { getWriteNamespace } from '../services/vectorize';

/**
 * One-time migration: move vectors from stale `{projectId}:{userId}` namespaces
 * to the correct namespace computed by getWriteNamespace().
 *
 * Background: prior to the namespace fix, all vectorInsert calls used the
 * template `${projectId}:${userId}` unconditionally. When userId was 'default'
 * or 'global', cascadingSearch never queried that namespace, so reads returned
 * nothing. This migration moves those orphaned vectors to the namespace that
 * cascadingSearch actually queries.
 */

// Vectorize getByIds limit is 20 IDs per call
const BATCH_SIZE = 20;

interface TableMigration {
  table: string;
  processed: number;
  migrated: number;
  skipped: number;
  errors: string[];
}

export interface MigrationResult {
  tables: TableMigration[];
  totalMigrated: number;
  totalSkipped: number;
  totalErrors: number;
}

interface VectorRecord {
  vector_id: string;
  project_id: string;
  user_id: string;
}

/**
 * Migrate vectors for a single table+index pair.
 */
async function migrateTableVectors(
  env: Bindings,
  tableName: string,
  index: VectorizeIndex,
  records: VectorRecord[]
): Promise<TableMigration> {
  const result: TableMigration = {
    table: tableName,
    processed: records.length,
    migrated: 0,
    skipped: 0,
    errors: [],
  };

  // Process in batches
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const vectorIds = batch.map((r) => r.vector_id);

    try {
      // 1. Get existing vectors by ID (returns values + metadata regardless of namespace)
      const existingVectors = await index.getByIds(vectorIds);

      if (existingVectors.length === 0) {
        // Vectors don't exist in Vectorize (orphaned D1 records) — skip
        result.skipped += batch.length;
        continue;
      }

      // Build a lookup from vector ID → record for namespace computation
      const recordMap = new Map<string, VectorRecord>();
      for (const rec of batch) {
        recordMap.set(rec.vector_id, rec);
      }

      // 2. Build re-namespaced vectors
      const toMigrate: VectorizeVector[] = [];
      for (const vec of existingVectors) {
        const rec = recordMap.get(vec.id);
        if (!rec) {
          result.skipped += 1;
          continue;
        }

        const correctNamespace = getWriteNamespace(rec.project_id, rec.user_id);
        const oldNamespace = `${rec.project_id}:${rec.user_id}`;

        // Only migrate if the namespace actually differs
        if (correctNamespace === oldNamespace) {
          result.skipped += 1;
          continue;
        }

        toMigrate.push({
          id: vec.id,
          values: vec.values as number[],
          namespace: correctNamespace,
          metadata: vec.metadata ?? undefined,
        });
      }

      // Count vectors that existed in Vectorize but don't need migration
      const foundIds = new Set(existingVectors.map((v) => v.id));
      const notFound = batch.filter((r) => !foundIds.has(r.vector_id));
      result.skipped += notFound.length;

      if (toMigrate.length === 0) {
        continue;
      }

      // 3. Delete old vectors
      const migrateIds = toMigrate.map((v) => v.id);
      await index.deleteByIds(migrateIds);

      // 4. Insert with corrected namespace
      await index.insert(toMigrate);

      result.migrated += toMigrate.length;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Batch starting at ${i}: ${msg}`);
    }
  }

  return result;
}

/**
 * Run the full namespace migration across all tables and Vectorize indexes.
 */
export async function migrateNamespaces(env: Bindings): Promise<MigrationResult> {
  const tables: TableMigration[] = [];

  // --- Entities ---
  const entityRows = await env.DB.prepare(
    `SELECT vector_id, project_id, user_id FROM entities
     WHERE user_id IN ('default', 'global') AND vector_id IS NOT NULL`
  ).all<VectorRecord>();
  tables.push(
    await migrateTableVectors(env, 'entities', env.VEC_ENTITIES, entityRows.results)
  );

  // --- Preferences ---
  const prefRows = await env.DB.prepare(
    `SELECT vector_id, project_id, user_id FROM preferences
     WHERE user_id IN ('default', 'global') AND vector_id IS NOT NULL`
  ).all<VectorRecord>();
  tables.push(
    await migrateTableVectors(env, 'preferences', env.VEC_PREFERENCES, prefRows.results)
  );

  // --- Facts ---
  const factRows = await env.DB.prepare(
    `SELECT vector_id, project_id, user_id FROM facts
     WHERE user_id IN ('default', 'global') AND vector_id IS NOT NULL`
  ).all<VectorRecord>();
  tables.push(
    await migrateTableVectors(env, 'facts', env.VEC_FACTS, factRows.results)
  );

  // --- Reasoning Traces ---
  const traceRows = await env.DB.prepare(
    `SELECT vector_id, project_id, user_id FROM reasoning_traces
     WHERE user_id IN ('default', 'global') AND vector_id IS NOT NULL`
  ).all<VectorRecord>();
  tables.push(
    await migrateTableVectors(env, 'reasoning_traces', env.VEC_TRACES, traceRows.results)
  );

  // --- Messages (inherits project_id/user_id from sessions) ---
  const msgRows = await env.DB.prepare(
    `SELECT m.vector_id, s.project_id, s.user_id
     FROM messages m
     JOIN sessions s ON m.session_id = s.id
     WHERE s.user_id IN ('default', 'global') AND m.vector_id IS NOT NULL`
  ).all<VectorRecord>();
  tables.push(
    await migrateTableVectors(env, 'messages', env.VEC_MESSAGES, msgRows.results)
  );

  const totalMigrated = tables.reduce((sum, t) => sum + t.migrated, 0);
  const totalSkipped = tables.reduce((sum, t) => sum + t.skipped, 0);
  const totalErrors = tables.reduce((sum, t) => sum + t.errors.length, 0);

  return { tables, totalMigrated, totalSkipped, totalErrors };
}
