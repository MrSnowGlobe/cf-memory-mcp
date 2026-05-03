import type {
  Bindings,
  EntityRow,
  RelationRow,
  PreferenceRow,
  FactRow,
  SearchResult,
} from '../types';
import type {
  AddEntityInput,
  UpdateEntityInput,
  AddPreferenceInput,
  AddFactInput,
  UpdatePreferenceInput,
  UpdateFactInput,
} from '../utils/validation';
import { generateId } from '../utils/ids';
import { NotFoundError } from '../utils/errors';
import {
  getEmbedding,
  entityEmbeddingText,
  preferenceEmbeddingText,
  factEmbeddingText,
} from '../services/embeddings';
import {
  vectorInsert,
  vectorDelete,
  cascadingSearch,
  getWriteNamespace,
} from '../services/vectorize';
import { resolveEntity } from '../services/resolution';
import {
  traverseRelations,
  traverseSubgraph,
  type TraverseOptions,
  type SubgraphResult,
} from '../services/graph';
import { publishEvent } from '../services/events';
import type { NeighborRow } from '../types';

export class LongTermMemory {
  constructor(
    private env: Bindings,
    private projectId: string,
    private userId: string = 'default'
  ) {}

  // ---------------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------------

  async addEntity(input: AddEntityInput): Promise<EntityRow> {
    // 1. Run entity resolution first — deduplicate
    const existing = await resolveEntity(
      this.env,
      input.name,
      input.entity_type,
      this.projectId,
      this.userId
    );

    if (existing) {
      return existing;
    }

    // 2. No match found — create new entity
    const id = generateId();
    const now = new Date().toISOString();
    const metaJson = JSON.stringify(input.metadata ?? {});

    // Run the embedding call in parallel with the D1 insert: the insert
    // doesn't depend on the embedding (vector_id is just our generated id),
    // so we can overlap the Workers AI latency with the D1 write.
    const [embedding] = await Promise.all([
      getEmbedding(
        entityEmbeddingText(input.name, input.description ?? null),
        this.env.AI
      ),
      this.env.DB.prepare(
        `INSERT INTO entities (id, project_id, user_id, name, entity_type, subtype, description, metadata, created_at, updated_at, vector_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id,
          this.projectId,
          this.userId,
          input.name,
          input.entity_type,
          input.subtype ?? null,
          input.description ?? null,
          metaJson,
          now,
          now,
          id
        )
        .run(),
    ]);

    // Insert vector into Vectorize with scoped namespace
    await vectorInsert(this.env.VEC_ENTITIES, id, embedding, getWriteNamespace(this.projectId, this.userId), {
      entity_type: input.entity_type,
      name: input.name,
    });

    // 6. Return the new entity row
    const row: EntityRow = {
      id,
      project_id: this.projectId,
      user_id: this.userId,
      name: input.name,
      entity_type: input.entity_type,
      subtype: input.subtype ?? null,
      description: input.description ?? null,
      promoted_from: null,
      metadata: metaJson,
      created_at: now,
      updated_at: now,
      vector_id: id,
    };
    await publishEvent(this.env, this.projectId, this.userId, 'entity_added', {
      id: row.id,
      name: row.name,
      entity_type: row.entity_type,
      subtype: row.subtype,
      description: row.description,
    });
    return row;
  }

  async getEntity(id: string): Promise<EntityRow | null> {
    const result = await this.env.DB.prepare(
      'SELECT * FROM entities WHERE id = ? AND project_id = ? AND user_id = ?'
    )
      .bind(id, this.projectId, this.userId)
      .first<EntityRow>();

    return result ?? null;
  }

  async updateEntity(
    id: string,
    updates: UpdateEntityInput
  ): Promise<EntityRow> {
    // 1. Verify entity exists and belongs to this project
    const existing = await this.getEntity(id);
    if (!existing) {
      throw new NotFoundError(`Entity ${id}`);
    }

    // 2. Build dynamic SET clause
    const setClauses: string[] = [];
    const bindValues: (string | null)[] = [];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      bindValues.push(updates.name);
    }
    if (updates.entity_type !== undefined) {
      setClauses.push('entity_type = ?');
      bindValues.push(updates.entity_type);
    }
    if (updates.subtype !== undefined) {
      setClauses.push('subtype = ?');
      bindValues.push(updates.subtype);
    }
    if (updates.description !== undefined) {
      setClauses.push('description = ?');
      bindValues.push(updates.description);
    }
    if (updates.metadata !== undefined) {
      setClauses.push('metadata = ?');
      bindValues.push(JSON.stringify(updates.metadata));
    }

    // Always update updated_at
    const now = new Date().toISOString();
    setClauses.push('updated_at = ?');
    bindValues.push(now);

    // 3. Execute the update
    const sql = `UPDATE entities SET ${setClauses.join(', ')} WHERE id = ? AND project_id = ? AND user_id = ?`;
    bindValues.push(id, this.projectId, this.userId);

    await this.env.DB.prepare(sql)
      .bind(...bindValues)
      .run();

    // 4. If name or description changed, re-embed and update vector
    if (updates.name !== undefined || updates.description !== undefined) {
      const newName = updates.name ?? existing.name;
      const newType = updates.entity_type ?? existing.entity_type;
      const newDesc = updates.description !== undefined
        ? updates.description
        : existing.description;
      const embedding = await getEmbedding(
        entityEmbeddingText(newName, newDesc),
        this.env.AI
      );

      // Delete old vector and insert new one
      if (existing.vector_id) {
        await vectorDelete(this.env.VEC_ENTITIES, [existing.vector_id]);
      }
      await vectorInsert(
        this.env.VEC_ENTITIES,
        id,
        embedding,
        getWriteNamespace(this.projectId, this.userId),
        {
          entity_type: newType,
          name: newName,
        }
      );
    }

    // 5. Build the updated row locally instead of re-querying
    const row: EntityRow = {
      ...existing,
      name: updates.name ?? existing.name,
      entity_type: updates.entity_type ?? existing.entity_type,
      subtype: updates.subtype !== undefined ? updates.subtype : existing.subtype,
      description: updates.description !== undefined ? updates.description : existing.description,
      metadata: updates.metadata !== undefined ? JSON.stringify(updates.metadata) : existing.metadata,
      updated_at: now,
    };
    await publishEvent(this.env, this.projectId, this.userId, 'entity_updated', {
      id: row.id,
      name: row.name,
      entity_type: row.entity_type,
      subtype: row.subtype,
      description: row.description,
    });
    return row;
  }

  async deleteEntity(id: string): Promise<void> {
    // 1. Get entity first to verify ownership and get vector_id
    const entity = await this.getEntity(id);
    if (!entity) {
      return; // Silently ignore if not found
    }

    // 2. Delete vector from VEC_ENTITIES if it exists
    if (entity.vector_id) {
      await vectorDelete(this.env.VEC_ENTITIES, [entity.vector_id]);
    }

    // 3. Delete relations and entity from D1 (relations first due to FK)
    await this.env.DB.batch([
      this.env.DB.prepare(
        'DELETE FROM entity_relations WHERE source_entity_id = ? OR target_entity_id = ?'
      ).bind(id, id),
      this.env.DB.prepare(
        'DELETE FROM entities WHERE id = ? AND project_id = ? AND user_id = ?'
      ).bind(id, this.projectId, this.userId),
    ]);

    await publishEvent(this.env, this.projectId, this.userId, 'entity_deleted', {
      id: entity.id,
      name: entity.name,
    });
  }

  async searchEntities(
    query: string,
    limit: number = 10
  ): Promise<SearchResult[]> {
    const embedding = await getEmbedding(query, this.env.AI);
    return cascadingSearch(
      this.env.VEC_ENTITIES,
      embedding,
      this.projectId,
      this.userId,
      limit
    );
  }

  async addRelation(
    sourceId: string,
    targetId: string,
    relationType: string,
    metadata?: Record<string, unknown>,
    strength: number = 1.0
  ): Promise<RelationRow> {
    const id = generateId();
    const now = new Date().toISOString();
    const metaJson = JSON.stringify(metadata ?? {});

    // Re-asserting an edge refreshes its strength + metadata so callers can
    // express "I saw this again, here's the latest weight."
    const row = await this.env.DB.prepare(
      `INSERT INTO entity_relations (id, source_entity_id, target_entity_id, relation_type, relation_strength, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_entity_id, target_entity_id, relation_type)
       DO UPDATE SET relation_strength = excluded.relation_strength, metadata = excluded.metadata
       RETURNING *`
    )
      .bind(id, sourceId, targetId, relationType, strength, metaJson, now)
      .first<RelationRow>();

    if (!row) {
      throw new Error('Failed to insert or retrieve relation');
    }
    await publishEvent(this.env, this.projectId, this.userId, 'relation_added', {
      id: row.id,
      source_entity_id: row.source_entity_id,
      target_entity_id: row.target_entity_id,
      relation_type: row.relation_type,
      relation_strength: row.relation_strength,
    });
    return row;
  }

  async getRelations(entityId: string, limit: number = 100): Promise<RelationRow[]> {
    const result = await this.env.DB.prepare(
      'SELECT * FROM entity_relations WHERE source_entity_id = ? OR target_entity_id = ? ORDER BY created_at DESC LIMIT ?'
    )
      .bind(entityId, entityId, limit)
      .all<RelationRow>();

    return result.results;
  }

  async traverseRelations(
    rootId: string,
    opts?: TraverseOptions
  ): Promise<NeighborRow[]> {
    return traverseRelations(this.env, rootId, this.projectId, this.userId, opts);
  }

  async traverseSubgraph(
    rootId: string,
    opts?: TraverseOptions
  ): Promise<SubgraphResult> {
    return traverseSubgraph(this.env, rootId, this.projectId, this.userId, opts);
  }

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------

  async addPreference(input: AddPreferenceInput): Promise<PreferenceRow> {
    const id = generateId();
    const now = new Date().toISOString();
    const metaJson = JSON.stringify(input.metadata ?? {});
    const confidence = input.confidence ?? 1.0;

    // Embedding + D1 insert in parallel (insert doesn't depend on the embedding).
    const [embedding] = await Promise.all([
      getEmbedding(
        preferenceEmbeddingText(input.category, input.preference, input.context ?? null),
        this.env.AI
      ),
      this.env.DB.prepare(
        `INSERT INTO preferences (id, project_id, user_id, category, preference, context, confidence, metadata, created_at, updated_at, vector_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id,
          this.projectId,
          this.userId,
          input.category,
          input.preference,
          input.context ?? null,
          confidence,
          metaJson,
          now,
          now,
          id
        )
        .run(),
    ]);

    // Insert vector into Vectorize with scoped namespace
    await vectorInsert(
      this.env.VEC_PREFERENCES,
      id,
      embedding,
      getWriteNamespace(this.projectId, this.userId),
      { category: input.category }
    );

    const row: PreferenceRow = {
      id,
      project_id: this.projectId,
      user_id: this.userId,
      category: input.category,
      preference: input.preference,
      context: input.context ?? null,
      confidence,
      promoted_from: null,
      metadata: metaJson,
      created_at: now,
      updated_at: now,
      vector_id: id,
    };
    await publishEvent(this.env, this.projectId, this.userId, 'preference_added', {
      id: row.id,
      category: row.category,
      preference: row.preference,
      context: row.context,
    });
    return row;
  }

  async listPreferences(category?: string): Promise<PreferenceRow[]> {
    if (category) {
      const result = await this.env.DB.prepare(
        'SELECT * FROM preferences WHERE project_id = ? AND user_id = ? AND category = ? ORDER BY created_at DESC'
      )
        .bind(this.projectId, this.userId, category)
        .all<PreferenceRow>();

      return result.results;
    }

    const result = await this.env.DB.prepare(
      'SELECT * FROM preferences WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC'
    )
      .bind(this.projectId, this.userId)
      .all<PreferenceRow>();

    return result.results;
  }

  async updatePreference(
    id: string,
    updates: UpdatePreferenceInput
  ): Promise<PreferenceRow> {
    const existing = await this.env.DB.prepare(
      'SELECT * FROM preferences WHERE id = ? AND project_id = ? AND user_id = ?'
    )
      .bind(id, this.projectId, this.userId)
      .first<PreferenceRow>();

    if (!existing) {
      throw new NotFoundError(`Preference ${id}`);
    }

    const setClauses: string[] = [];
    const bindValues: (string | number | null)[] = [];

    if (updates.category !== undefined) {
      setClauses.push('category = ?');
      bindValues.push(updates.category);
    }
    if (updates.preference !== undefined) {
      setClauses.push('preference = ?');
      bindValues.push(updates.preference);
    }
    if (updates.context !== undefined) {
      setClauses.push('context = ?');
      bindValues.push(updates.context);
    }
    if (updates.confidence !== undefined) {
      setClauses.push('confidence = ?');
      bindValues.push(updates.confidence);
    }
    if (updates.metadata !== undefined) {
      setClauses.push('metadata = ?');
      bindValues.push(JSON.stringify(updates.metadata));
    }

    const now = new Date().toISOString();
    setClauses.push('updated_at = ?');
    bindValues.push(now);

    const sql = `UPDATE preferences SET ${setClauses.join(', ')} WHERE id = ? AND project_id = ? AND user_id = ?`;
    bindValues.push(id, this.projectId, this.userId);

    await this.env.DB.prepare(sql).bind(...bindValues).run();

    const searchableChanged =
      updates.category !== undefined ||
      updates.preference !== undefined ||
      updates.context !== undefined;

    if (searchableChanged && existing.vector_id) {
      const newCategory = updates.category ?? existing.category;
      const newPreference = updates.preference ?? existing.preference;
      const newContext = updates.context !== undefined ? updates.context : existing.context;
      const embedding = await getEmbedding(
        preferenceEmbeddingText(newCategory, newPreference, newContext),
        this.env.AI
      );
      await vectorDelete(this.env.VEC_PREFERENCES, [existing.vector_id]);
      await vectorInsert(
        this.env.VEC_PREFERENCES,
        id,
        embedding,
        getWriteNamespace(this.projectId, this.userId),
        { category: newCategory }
      );
    }

    const row: PreferenceRow = {
      ...existing,
      category: updates.category ?? existing.category,
      preference: updates.preference ?? existing.preference,
      context: updates.context !== undefined ? updates.context : existing.context,
      confidence: updates.confidence ?? existing.confidence,
      metadata: updates.metadata !== undefined ? JSON.stringify(updates.metadata) : existing.metadata,
      updated_at: now,
    };
    await publishEvent(this.env, this.projectId, this.userId, 'preference_updated', {
      id: row.id,
      category: row.category,
      preference: row.preference,
      context: row.context,
    });
    return row;
  }

  async searchPreferences(
    query: string,
    limit: number = 10
  ): Promise<SearchResult[]> {
    const embedding = await getEmbedding(query, this.env.AI);
    return cascadingSearch(
      this.env.VEC_PREFERENCES,
      embedding,
      this.projectId,
      this.userId,
      limit,
      { preferenceDedup: true }
    );
  }

  // ---------------------------------------------------------------------------
  // Facts
  // ---------------------------------------------------------------------------

  async addFact(input: AddFactInput): Promise<FactRow> {
    const id = generateId();
    const now = new Date().toISOString();
    const metaJson = JSON.stringify(input.metadata ?? {});
    const confidence = input.confidence ?? 1.0;

    // Embedding + D1 insert in parallel (insert doesn't depend on the embedding).
    const [embedding] = await Promise.all([
      getEmbedding(
        factEmbeddingText(input.subject, input.predicate, input.object),
        this.env.AI
      ),
      this.env.DB.prepare(
        `INSERT INTO facts (id, project_id, user_id, subject, predicate, object, valid_from, valid_until, confidence, source, metadata, created_at, vector_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id,
          this.projectId,
          this.userId,
          input.subject,
          input.predicate,
          input.object,
          input.valid_from ?? null,
          input.valid_until ?? null,
          confidence,
          input.source ?? null,
          metaJson,
          now,
          id
        )
        .run(),
    ]);

    // Insert vector into Vectorize with scoped namespace
    await vectorInsert(this.env.VEC_FACTS, id, embedding, getWriteNamespace(this.projectId, this.userId), {
      subject: input.subject,
      predicate: input.predicate,
    });

    const row: FactRow = {
      id,
      project_id: this.projectId,
      user_id: this.userId,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      valid_from: input.valid_from ?? null,
      valid_until: input.valid_until ?? null,
      confidence,
      source: input.source ?? null,
      promoted_from: null,
      metadata: metaJson,
      created_at: now,
      vector_id: id,
    };
    await publishEvent(this.env, this.projectId, this.userId, 'fact_added', {
      id: row.id,
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
    });
    return row;
  }

  async listFacts(opts?: {
    subject?: string;
    predicate?: string;
  }): Promise<FactRow[]> {
    // Build WHERE clause dynamically; always filter expired facts
    const conditions: string[] = ['project_id = ?', 'user_id = ?'];
    const bindings: (string | number)[] = [this.projectId, this.userId];

    // Filter out expired facts — use JS timestamp as binding, not datetime('now')
    const now = new Date().toISOString();
    conditions.push('(valid_until IS NULL OR valid_until > ?)');
    bindings.push(now);

    if (opts?.subject) {
      conditions.push('subject = ?');
      bindings.push(opts.subject);
    }
    if (opts?.predicate) {
      conditions.push('predicate = ?');
      bindings.push(opts.predicate);
    }

    const sql = `SELECT * FROM facts WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`;

    const result = await this.env.DB.prepare(sql)
      .bind(...bindings)
      .all<FactRow>();

    return result.results;
  }

  async searchFacts(
    query: string,
    limit: number = 10
  ): Promise<SearchResult[]> {
    const embedding = await getEmbedding(query, this.env.AI);
    // Pull a wider candidate set so the post-filter for expired facts
    // doesn't cause us to return fewer rows than `limit` when the top
    // matches happen to be stale.
    const candidates = await cascadingSearch(
      this.env.VEC_FACTS,
      embedding,
      this.projectId,
      this.userId,
      limit * 2
    );
    if (candidates.length === 0) return [];

    // Ask D1 which of these vector ids are still valid, then filter the
    // SearchResult list in place (preserving score ordering and scope).
    const placeholders = candidates.map(() => '?').join(', ');
    const now = new Date().toISOString();
    const liveRows = await this.env.DB.prepare(
      `SELECT id FROM facts WHERE id IN (${placeholders}) AND (valid_until IS NULL OR valid_until > ?)`
    )
      .bind(...candidates.map((c) => c.id), now)
      .all<{ id: string }>();
    const liveIds = new Set(liveRows.results.map((r) => r.id));
    return candidates.filter((c) => liveIds.has(c.id)).slice(0, limit);
  }

  async updateFact(id: string, updates: UpdateFactInput): Promise<FactRow> {
    const existing = await this.env.DB.prepare(
      'SELECT * FROM facts WHERE id = ? AND project_id = ? AND user_id = ?'
    )
      .bind(id, this.projectId, this.userId)
      .first<FactRow>();

    if (!existing) {
      throw new NotFoundError(`Fact ${id}`);
    }

    const setClauses: string[] = [];
    const bindValues: (string | number | null)[] = [];

    if (updates.subject !== undefined) {
      setClauses.push('subject = ?');
      bindValues.push(updates.subject);
    }
    if (updates.predicate !== undefined) {
      setClauses.push('predicate = ?');
      bindValues.push(updates.predicate);
    }
    if (updates.object !== undefined) {
      setClauses.push('object = ?');
      bindValues.push(updates.object);
    }
    if (updates.valid_from !== undefined) {
      setClauses.push('valid_from = ?');
      bindValues.push(updates.valid_from);
    }
    if (updates.valid_until !== undefined) {
      setClauses.push('valid_until = ?');
      bindValues.push(updates.valid_until);
    }
    if (updates.confidence !== undefined) {
      setClauses.push('confidence = ?');
      bindValues.push(updates.confidence);
    }
    if (updates.source !== undefined) {
      setClauses.push('source = ?');
      bindValues.push(updates.source);
    }
    if (updates.metadata !== undefined) {
      setClauses.push('metadata = ?');
      bindValues.push(JSON.stringify(updates.metadata));
    }

    if (setClauses.length === 0) {
      return existing;
    }

    const sql = `UPDATE facts SET ${setClauses.join(', ')} WHERE id = ? AND project_id = ? AND user_id = ?`;
    bindValues.push(id, this.projectId, this.userId);
    await this.env.DB.prepare(sql).bind(...bindValues).run();

    const searchableChanged =
      updates.subject !== undefined ||
      updates.predicate !== undefined ||
      updates.object !== undefined;

    if (searchableChanged && existing.vector_id) {
      const newSubject = updates.subject ?? existing.subject;
      const newPredicate = updates.predicate ?? existing.predicate;
      const newObject = updates.object ?? existing.object;
      const embedding = await getEmbedding(
        factEmbeddingText(newSubject, newPredicate, newObject),
        this.env.AI
      );
      await vectorDelete(this.env.VEC_FACTS, [existing.vector_id]);
      await vectorInsert(
        this.env.VEC_FACTS,
        id,
        embedding,
        getWriteNamespace(this.projectId, this.userId),
        { subject: newSubject, predicate: newPredicate }
      );
    }

    const row: FactRow = {
      ...existing,
      subject: updates.subject ?? existing.subject,
      predicate: updates.predicate ?? existing.predicate,
      object: updates.object ?? existing.object,
      valid_from: updates.valid_from !== undefined ? updates.valid_from : existing.valid_from,
      valid_until: updates.valid_until !== undefined ? updates.valid_until : existing.valid_until,
      confidence: updates.confidence ?? existing.confidence,
      source: updates.source !== undefined ? updates.source : existing.source,
      metadata: updates.metadata !== undefined ? JSON.stringify(updates.metadata) : existing.metadata,
    };
    await publishEvent(this.env, this.projectId, this.userId, 'fact_updated', {
      id: row.id,
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
    });
    return row;
  }

  async invalidateFact(id: string, validUntil?: string): Promise<void> {
    const until = validUntil ?? new Date().toISOString();

    const result = await this.env.DB.prepare(
      'UPDATE facts SET valid_until = ? WHERE id = ? AND project_id = ? AND user_id = ?'
    )
      .bind(until, id, this.projectId, this.userId)
      .run();

    if (result.meta.changes === 0) {
      throw new NotFoundError(`Fact ${id}`);
    }

    await publishEvent(this.env, this.projectId, this.userId, 'fact_invalidated', {
      id,
      valid_until: until,
    });
  }
}
