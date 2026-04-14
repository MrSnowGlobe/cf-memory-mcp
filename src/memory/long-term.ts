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
} from '../utils/validation';
import { generateId } from '../utils/ids';
import { getEmbedding } from '../services/embeddings';
import {
  vectorInsert,
  vectorDelete,
  cascadingSearch,
  getWriteNamespace,
} from '../services/vectorize';
import { resolveEntity } from '../services/resolution';

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

    // 3. Generate embedding
    const embeddingText = `${input.name} ${input.entity_type} ${input.description ?? ''}`;
    const embedding = await getEmbedding(embeddingText, this.env.AI);

    // 4. Insert into D1
    await this.env.DB.prepare(
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
      .run();

    // 5. Insert vector into Vectorize with scoped namespace
    await vectorInsert(this.env.VEC_ENTITIES, id, embedding, getWriteNamespace(this.projectId, this.userId), {
      entity_type: input.entity_type,
      name: input.name,
    });

    // 6. Return the new entity row
    return {
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
      throw new Error(
        `Entity ${id} not found in project ${this.projectId}`
      );
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
      const embeddingText = `${newName} ${newType} ${newDesc ?? ''}`;
      const embedding = await getEmbedding(embeddingText, this.env.AI);

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
    return {
      ...existing,
      name: updates.name ?? existing.name,
      entity_type: updates.entity_type ?? existing.entity_type,
      subtype: updates.subtype !== undefined ? updates.subtype : existing.subtype,
      description: updates.description !== undefined ? updates.description : existing.description,
      metadata: updates.metadata !== undefined ? JSON.stringify(updates.metadata) : existing.metadata,
      updated_at: now,
    };
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
    metadata?: Record<string, unknown>
  ): Promise<RelationRow> {
    const id = generateId();
    const now = new Date().toISOString();
    const metaJson = JSON.stringify(metadata ?? {});

    // Use INSERT OR IGNORE to handle duplicates without race conditions
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO entity_relations (id, source_entity_id, target_entity_id, relation_type, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(id, sourceId, targetId, relationType, metaJson, now)
      .run();

    // If the insert was ignored (duplicate), fetch the existing row
    const existing = await this.env.DB.prepare(
      `SELECT * FROM entity_relations
       WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?
       LIMIT 1`
    )
      .bind(sourceId, targetId, relationType)
      .first<RelationRow>();

    if (existing) {
      return existing;
    }

    return {
      id,
      source_entity_id: sourceId,
      target_entity_id: targetId,
      relation_type: relationType,
      metadata: metaJson,
      created_at: now,
    };
  }

  async getRelations(entityId: string, limit: number = 100): Promise<RelationRow[]> {
    const result = await this.env.DB.prepare(
      'SELECT * FROM entity_relations WHERE source_entity_id = ? OR target_entity_id = ? ORDER BY created_at DESC LIMIT ?'
    )
      .bind(entityId, entityId, limit)
      .all<RelationRow>();

    return result.results;
  }

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------

  async addPreference(input: AddPreferenceInput): Promise<PreferenceRow> {
    const id = generateId();
    const now = new Date().toISOString();
    const metaJson = JSON.stringify(input.metadata ?? {});
    const confidence = input.confidence ?? 1.0;

    // Generate embedding
    const embeddingText = `${input.category}: ${input.preference}${input.context ? ' (' + input.context + ')' : ''}`;
    const embedding = await getEmbedding(embeddingText, this.env.AI);

    // Insert into D1
    await this.env.DB.prepare(
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
      .run();

    // Insert vector into Vectorize with scoped namespace
    await vectorInsert(
      this.env.VEC_PREFERENCES,
      id,
      embedding,
      getWriteNamespace(this.projectId, this.userId),
      { category: input.category }
    );

    return {
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

    // Generate embedding
    const embeddingText = `${input.subject} ${input.predicate} ${input.object}`;
    const embedding = await getEmbedding(embeddingText, this.env.AI);

    // Insert into D1
    await this.env.DB.prepare(
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
      .run();

    // Insert vector into Vectorize with scoped namespace
    await vectorInsert(this.env.VEC_FACTS, id, embedding, getWriteNamespace(this.projectId, this.userId), {
      subject: input.subject,
      predicate: input.predicate,
    });

    return {
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
    return cascadingSearch(
      this.env.VEC_FACTS,
      embedding,
      this.projectId,
      this.userId,
      limit
    );
  }

  async invalidateFact(id: string, validUntil?: string): Promise<void> {
    const until = validUntil ?? new Date().toISOString();

    await this.env.DB.prepare(
      'UPDATE facts SET valid_until = ? WHERE id = ? AND project_id = ? AND user_id = ?'
    )
      .bind(until, id, this.projectId, this.userId)
      .run();
  }
}
