import type { Bindings, EntityRow, PreferenceRow, FactRow } from '../types';
import { generateId } from '../utils/ids';
import { vectorInsert } from '../services/vectorize';
import { publishEvent } from '../services/events';

type PromotionType = 'entity' | 'preference' | 'fact';
type PromotionTarget = 'user' | 'global';

const INDEX_BY_TYPE: Record<PromotionType, keyof Pick<Bindings,
  'VEC_ENTITIES' | 'VEC_PREFERENCES' | 'VEC_FACTS'>> = {
  entity: 'VEC_ENTITIES',
  preference: 'VEC_PREFERENCES',
  fact: 'VEC_FACTS',
};

/**
 * Promote a project-scoped record to a broader scope (COPY, not move).
 *
 * Idempotent: promoting the same record to the same scope twice returns
 * the same `promotedId`. Protected by a unique index on promotion_log
 * plus an explicit pre-check for a friendly response.
 */
export async function promote(
  env: Bindings,
  projectId: string,
  userId: string,
  type: PromotionType,
  id: string,
  reason: string,
  target: PromotionTarget = 'global'
): Promise<{ promotedId: string }> {
  const existing = await env.DB.prepare(
    `SELECT global_record_id FROM promotion_log
     WHERE source_project_id = ? AND source_user_id = ?
       AND target_type = ? AND source_record_id = ? AND target_scope = ?`
  )
    .bind(projectId, userId, type, id, target)
    .first<{ global_record_id: string }>();

  if (existing) {
    return { promotedId: existing.global_record_id };
  }

  const promotedId = generateId();
  const now = new Date().toISOString();
  const targetProjectId = 'global';
  const targetUserId = target === 'global' ? 'global' : userId;
  const targetNamespace = target === 'global' ? 'global' : `user:${userId}`;

  const auditStmt = env.DB.prepare(
    `INSERT INTO promotion_log (id, source_project_id, source_user_id, target_type, source_record_id, global_record_id, reason, promoted_at, target_scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(generateId(), projectId, userId, type, id, promotedId, reason, now, target);

  if (type === 'entity') {
    const row = await env.DB.prepare(
      'SELECT * FROM entities WHERE id = ? AND project_id = ? AND user_id = ?'
    )
      .bind(id, projectId, userId)
      .first<EntityRow>();

    if (!row) throw new Error(`entity ${id} not found in project ${projectId}`);

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

    await env.DB.batch([insertStmt, auditStmt]);

    await copyVector(env[INDEX_BY_TYPE[type]], row.vector_id, promotedId, targetNamespace, {
      name: row.name,
      entity_type: row.entity_type,
    });
  } else if (type === 'preference') {
    const row = await env.DB.prepare(
      'SELECT * FROM preferences WHERE id = ? AND project_id = ? AND user_id = ?'
    )
      .bind(id, projectId, userId)
      .first<PreferenceRow>();

    if (!row) throw new Error(`preference ${id} not found in project ${projectId}`);

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

    await env.DB.batch([insertStmt, auditStmt]);

    await copyVector(env[INDEX_BY_TYPE[type]], row.vector_id, promotedId, targetNamespace, {
      category: row.category,
    });
  } else {
    const row = await env.DB.prepare(
      'SELECT * FROM facts WHERE id = ? AND project_id = ? AND user_id = ?'
    )
      .bind(id, projectId, userId)
      .first<FactRow>();

    if (!row) throw new Error(`fact ${id} not found in project ${projectId}`);

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

    await env.DB.batch([insertStmt, auditStmt]);

    await copyVector(env[INDEX_BY_TYPE[type]], row.vector_id, promotedId, targetNamespace, {
      subject: row.subject,
      predicate: row.predicate,
    });
  }

  await publishEvent(env, projectId, userId, 'promoted', {
    type,
    source_id: id,
    promoted_id: promotedId,
    target,
    reason,
  });

  return { promotedId };
}

/**
 * Thin wrapper returning `{ globalId }` shape used by legacy callers and tests.
 */
export async function promoteToGlobal(
  env: Bindings,
  projectId: string,
  userId: string,
  type: PromotionType,
  id: string,
  reason: string
): Promise<{ globalId: string }> {
  const { promotedId } = await promote(env, projectId, userId, type, id, reason, 'global');
  return { globalId: promotedId };
}

/**
 * Copy an existing vector to a new ID and namespace without re-embedding.
 * Falls back gracefully if the source vector is missing from Vectorize.
 */
async function copyVector(
  index: VectorizeIndex,
  sourceVectorId: string | null,
  newId: string,
  namespace: string,
  metadata: Record<string, string>
): Promise<void> {
  if (!sourceVectorId) return;

  const [existing] = await index.getByIds([sourceVectorId]);
  if (!existing) {
    console.error(`[promotion] source vector ${sourceVectorId} missing from Vectorize`);
    return;
  }

  await vectorInsert(index, newId, Array.from(existing.values), namespace, metadata);
}
