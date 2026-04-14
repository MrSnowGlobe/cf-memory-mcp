import type { Bindings, EntityRow, PreferenceRow, FactRow } from '../types';
import { generateId } from '../utils/ids';
import { getEmbedding } from '../services/embeddings';
import { vectorInsert } from '../services/vectorize';

/**
 * Promote a project-scoped record to a broader scope.
 *
 * This is a COPY operation — the original row remains untouched in both D1 and Vectorize.
 *
 * target = 'global': new row gets project_id='global', user_id='global', namespace='global'
 * target = 'user':   new row gets project_id='global', user_id=userId,   namespace='user:{userId}'
 */
export async function promote(
  env: Bindings,
  projectId: string,
  userId: string,
  type: 'entity' | 'preference' | 'fact',
  id: string,
  reason: string,
  target: 'user' | 'global' = 'global'
): Promise<{ promotedId: string }> {
  const promotedId = generateId();
  const now = new Date().toISOString();

  const targetProjectId = 'global';
  const targetUserId = target === 'global' ? 'global' : userId;
  const targetNamespace = target === 'global' ? 'global' : `user:${userId}`;

  if (type === 'entity') {
    const row = await env.DB.prepare(
      'SELECT * FROM entities WHERE id = ? AND project_id = ? AND user_id = ?'
    )
      .bind(id, projectId, userId)
      .first<EntityRow>();

    if (!row) {
      throw new Error(`entity ${id} not found in project ${projectId}`);
    }

    const embeddingText = `${row.name} ${row.entity_type} ${row.description ?? ''}`;
    const embedding = await getEmbedding(embeddingText, env.AI);

    const insertStmt = env.DB.prepare(
      `INSERT INTO entities (id, project_id, user_id, name, entity_type, subtype, description, promoted_from, metadata, created_at, updated_at, vector_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      promotedId,
      targetProjectId,
      targetUserId,
      row.name,
      row.entity_type,
      row.subtype,
      row.description,
      projectId,
      row.metadata,
      now,
      now,
      promotedId
    );

    const auditStmt = env.DB.prepare(
      `INSERT INTO promotion_log (id, source_project_id, source_user_id, target_type, source_record_id, global_record_id, reason, promoted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(generateId(), projectId, userId, type, id, promotedId, reason, now);

    await env.DB.batch([insertStmt, auditStmt]);

    await vectorInsert(env.VEC_ENTITIES, promotedId, embedding, targetNamespace, {
      name: row.name,
      entity_type: row.entity_type,
    });
  } else if (type === 'preference') {
    const row = await env.DB.prepare(
      'SELECT * FROM preferences WHERE id = ? AND project_id = ? AND user_id = ?'
    )
      .bind(id, projectId, userId)
      .first<PreferenceRow>();

    if (!row) {
      throw new Error(`preference ${id} not found in project ${projectId}`);
    }

    const embeddingText = `${row.category}: ${row.preference}${row.context ? ' (' + row.context + ')' : ''}`;
    const embedding = await getEmbedding(embeddingText, env.AI);

    const insertStmt = env.DB.prepare(
      `INSERT INTO preferences (id, project_id, user_id, category, preference, context, confidence, promoted_from, metadata, created_at, updated_at, vector_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      promotedId,
      targetProjectId,
      targetUserId,
      row.category,
      row.preference,
      row.context,
      row.confidence,
      projectId,
      row.metadata,
      now,
      now,
      promotedId
    );

    const auditStmt = env.DB.prepare(
      `INSERT INTO promotion_log (id, source_project_id, source_user_id, target_type, source_record_id, global_record_id, reason, promoted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(generateId(), projectId, userId, type, id, promotedId, reason, now);

    await env.DB.batch([insertStmt, auditStmt]);

    await vectorInsert(env.VEC_PREFERENCES, promotedId, embedding, targetNamespace, {
      category: row.category,
    });
  } else {
    // type === 'fact'
    const row = await env.DB.prepare(
      'SELECT * FROM facts WHERE id = ? AND project_id = ? AND user_id = ?'
    )
      .bind(id, projectId, userId)
      .first<FactRow>();

    if (!row) {
      throw new Error(`fact ${id} not found in project ${projectId}`);
    }

    const embeddingText = `${row.subject} ${row.predicate} ${row.object}`;
    const embedding = await getEmbedding(embeddingText, env.AI);

    const insertStmt = env.DB.prepare(
      `INSERT INTO facts (id, project_id, user_id, subject, predicate, object, valid_from, valid_until, confidence, source, promoted_from, metadata, created_at, vector_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      promotedId,
      targetProjectId,
      targetUserId,
      row.subject,
      row.predicate,
      row.object,
      row.valid_from,
      row.valid_until,
      row.confidence,
      row.source,
      projectId,
      row.metadata,
      now,
      promotedId
    );

    const auditStmt = env.DB.prepare(
      `INSERT INTO promotion_log (id, source_project_id, source_user_id, target_type, source_record_id, global_record_id, reason, promoted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(generateId(), projectId, userId, type, id, promotedId, reason, now);

    await env.DB.batch([insertStmt, auditStmt]);

    await vectorInsert(env.VEC_FACTS, promotedId, embedding, targetNamespace, {
      subject: row.subject,
      predicate: row.predicate,
    });
  }

  return { promotedId };
}

/**
 * Convenience wrapper — promote to global scope.
 * Preserved for backward compatibility with existing callers.
 */
export async function promoteToGlobal(
  env: Bindings,
  projectId: string,
  userId: string,
  type: 'entity' | 'preference' | 'fact',
  id: string,
  reason: string
): Promise<{ globalId: string }> {
  const result = await promote(env, projectId, userId, type, id, reason, 'global');
  return { globalId: result.promotedId };
}
