import type { Bindings } from '../types';
import {
  getEmbeddings,
  entityEmbeddingText,
  preferenceEmbeddingText,
  factEmbeddingText,
} from '../services/embeddings';
import { getWriteNamespace } from '../services/vectorize';
import { EMBEDDING } from '../config';

/**
 * One-time migration: re-embed every existing vector with the currently
 * configured EMBEDDING.model and upsert it in place (same vector_id,
 * same namespace). Use this after changing the embedding model so all
 * stored vectors share the same semantic space.
 *
 * Safe to run multiple times. Each run overwrites the target vectors.
 */

const PAGE_SIZE = EMBEDDING.batchSize;

interface TableReembed {
  table: string;
  processed: number;
  updated: number;
  errors: string[];
}

export interface ReembedResult {
  tables: TableReembed[];
  totalProcessed: number;
  totalUpdated: number;
  totalErrors: number;
}

interface BatchInput {
  id: string;
  text: string;
  namespace: string;
  metadata: Record<string, string>;
}

async function upsertBatch(
  env: Bindings,
  index: VectorizeIndex,
  batch: BatchInput[],
  result: TableReembed
): Promise<void> {
  if (batch.length === 0) return;
  try {
    const embeddings = await getEmbeddings(
      batch.map((b) => b.text),
      env.AI
    );
    const vectors: VectorizeVector[] = batch.map((b, i) => ({
      id: b.id,
      values: embeddings[i]!,
      namespace: b.namespace,
      metadata: b.metadata,
    }));
    await index.upsert(vectors);
    result.updated += vectors.length;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(msg);
  }
}

async function reembedMessages(env: Bindings): Promise<TableReembed> {
  const result: TableReembed = { table: 'messages', processed: 0, updated: 0, errors: [] };
  let offset = 0;
  while (true) {
    const { results } = await env.DB.prepare(
      `SELECT m.id, m.vector_id, m.content, m.role, m.session_id, s.project_id, s.user_id
       FROM messages m JOIN sessions s ON m.session_id = s.id
       WHERE m.vector_id IS NOT NULL
       ORDER BY m.created_at, m.id
       LIMIT ? OFFSET ?`
    )
      .bind(PAGE_SIZE, offset)
      .all<{
        id: string;
        vector_id: string;
        content: string;
        role: string;
        session_id: string;
        project_id: string;
        user_id: string;
      }>();

    if (results.length === 0) break;
    result.processed += results.length;

    const batch: BatchInput[] = results.map((r) => ({
      id: r.vector_id,
      text: r.content,
      namespace: getWriteNamespace(r.project_id, r.user_id),
      metadata: { session_id: r.session_id, role: r.role },
    }));
    await upsertBatch(env, env.VEC_MESSAGES, batch, result);
    offset += PAGE_SIZE;
  }
  return result;
}

async function reembedEntities(env: Bindings): Promise<TableReembed> {
  const result: TableReembed = { table: 'entities', processed: 0, updated: 0, errors: [] };
  let offset = 0;
  while (true) {
    const { results } = await env.DB.prepare(
      `SELECT vector_id, name, description, entity_type, project_id, user_id
       FROM entities WHERE vector_id IS NOT NULL
       ORDER BY created_at, id LIMIT ? OFFSET ?`
    )
      .bind(PAGE_SIZE, offset)
      .all<{
        vector_id: string;
        name: string;
        description: string | null;
        entity_type: string;
        project_id: string;
        user_id: string;
      }>();

    if (results.length === 0) break;
    result.processed += results.length;

    const batch: BatchInput[] = results.map((r) => ({
      id: r.vector_id,
      text: entityEmbeddingText(r.name, r.description),
      namespace: getWriteNamespace(r.project_id, r.user_id),
      metadata: { entity_type: r.entity_type, name: r.name },
    }));
    await upsertBatch(env, env.VEC_ENTITIES, batch, result);
    offset += PAGE_SIZE;
  }
  return result;
}

async function reembedPreferences(env: Bindings): Promise<TableReembed> {
  const result: TableReembed = { table: 'preferences', processed: 0, updated: 0, errors: [] };
  let offset = 0;
  while (true) {
    const { results } = await env.DB.prepare(
      `SELECT vector_id, category, preference, context, project_id, user_id
       FROM preferences WHERE vector_id IS NOT NULL
       ORDER BY created_at, id LIMIT ? OFFSET ?`
    )
      .bind(PAGE_SIZE, offset)
      .all<{
        vector_id: string;
        category: string;
        preference: string;
        context: string | null;
        project_id: string;
        user_id: string;
      }>();

    if (results.length === 0) break;
    result.processed += results.length;

    const batch: BatchInput[] = results.map((r) => ({
      id: r.vector_id,
      text: preferenceEmbeddingText(r.category, r.preference, r.context),
      namespace: getWriteNamespace(r.project_id, r.user_id),
      metadata: { category: r.category },
    }));
    await upsertBatch(env, env.VEC_PREFERENCES, batch, result);
    offset += PAGE_SIZE;
  }
  return result;
}

async function reembedFacts(env: Bindings): Promise<TableReembed> {
  const result: TableReembed = { table: 'facts', processed: 0, updated: 0, errors: [] };
  let offset = 0;
  while (true) {
    const { results } = await env.DB.prepare(
      `SELECT vector_id, subject, predicate, object, project_id, user_id
       FROM facts WHERE vector_id IS NOT NULL
       ORDER BY created_at, id LIMIT ? OFFSET ?`
    )
      .bind(PAGE_SIZE, offset)
      .all<{
        vector_id: string;
        subject: string;
        predicate: string;
        object: string;
        project_id: string;
        user_id: string;
      }>();

    if (results.length === 0) break;
    result.processed += results.length;

    const batch: BatchInput[] = results.map((r) => ({
      id: r.vector_id,
      text: factEmbeddingText(r.subject, r.predicate, r.object),
      namespace: getWriteNamespace(r.project_id, r.user_id),
      metadata: { subject: r.subject, predicate: r.predicate },
    }));
    await upsertBatch(env, env.VEC_FACTS, batch, result);
    offset += PAGE_SIZE;
  }
  return result;
}

async function reembedTraces(env: Bindings): Promise<TableReembed> {
  const result: TableReembed = { table: 'reasoning_traces', processed: 0, updated: 0, errors: [] };
  let offset = 0;
  while (true) {
    const { results } = await env.DB.prepare(
      `SELECT vector_id, task, outcome, success, project_id, user_id
       FROM reasoning_traces WHERE vector_id IS NOT NULL
       ORDER BY started_at, id LIMIT ? OFFSET ?`
    )
      .bind(PAGE_SIZE, offset)
      .all<{
        vector_id: string;
        task: string;
        outcome: string | null;
        success: number | null;
        project_id: string;
        user_id: string;
      }>();

    if (results.length === 0) break;
    result.processed += results.length;

    const batch: BatchInput[] = results.map((r) => ({
      id: r.vector_id,
      // Match the live write path: richer task+outcome when completed,
      // task-only while still pending.
      text: r.outcome ? `${r.task}\n${r.outcome}` : r.task,
      namespace: getWriteNamespace(r.project_id, r.user_id),
      metadata: {
        task: r.task,
        success: r.success === null ? 'pending' : String(r.success === 1),
      },
    }));
    await upsertBatch(env, env.VEC_TRACES, batch, result);
    offset += PAGE_SIZE;
  }
  return result;
}

/**
 * Run re-embedding across all five tables. Sequential (not parallel) to
 * stay within Workers AI rate limits — one table's batches finish before
 * the next starts.
 */
export async function reembedAllVectors(env: Bindings): Promise<ReembedResult> {
  const tables: TableReembed[] = [];
  tables.push(await reembedMessages(env));
  tables.push(await reembedEntities(env));
  tables.push(await reembedPreferences(env));
  tables.push(await reembedFacts(env));
  tables.push(await reembedTraces(env));

  return {
    tables,
    totalProcessed: tables.reduce((s, t) => s + t.processed, 0),
    totalUpdated: tables.reduce((s, t) => s + t.updated, 0),
    totalErrors: tables.reduce((s, t) => s + t.errors.length, 0),
  };
}
