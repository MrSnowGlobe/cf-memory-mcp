import type {
  Bindings,
  SessionRow,
  MessageRow,
  SearchResult,
  PaginationOpts,
} from '../types';
import type { AddMessageInput } from '../utils/validation';
import { generateId } from '../utils/ids';
import { parsePagination } from '../utils/pagination';
import { getEmbedding, getEmbeddings } from '../services/embeddings';
import { cacheGet, cacheSet, cacheDelete } from '../services/cache';
import {
  vectorInsert,
  vectorDelete,
  cascadingSearch,
  getWriteNamespace,
} from '../services/vectorize';

export class ShortTermMemory {
  constructor(
    private env: Bindings,
    private projectId: string,
    private userId: string = 'default'
  ) {}

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  async createSession(
    id: string,
    metadata?: Record<string, unknown>
  ): Promise<SessionRow> {
    const now = new Date().toISOString();
    const metaJson = JSON.stringify(metadata ?? {});

    await this.env.DB.prepare(
      'INSERT INTO sessions (id, project_id, user_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(id, this.projectId, this.userId, metaJson, now, now)
      .run();

    return {
      id,
      project_id: this.projectId,
      user_id: this.userId,
      metadata: metaJson,
      created_at: now,
      updated_at: now,
    };
  }

  async listSessions(opts?: PaginationOpts): Promise<SessionRow[]> {
    const { limit, offset } = parsePagination(opts);

    const result = await this.env.DB.prepare(
      'SELECT * FROM sessions WHERE project_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?'
    )
      .bind(this.projectId, this.userId, limit, offset)
      .all<SessionRow>();

    return result.results;
  }

  async getSession(id: string): Promise<SessionRow | null> {
    const result = await this.env.DB.prepare(
      'SELECT * FROM sessions WHERE id = ? AND project_id = ? AND user_id = ?'
    )
      .bind(id, this.projectId, this.userId)
      .first<SessionRow>();

    return result ?? null;
  }

  async deleteSession(id: string): Promise<void> {
    // 1. Get all message vector IDs for this session so we can clean up Vectorize
    const messages = await this.env.DB.prepare(
      'SELECT vector_id FROM messages WHERE session_id = ? AND vector_id IS NOT NULL'
    )
      .bind(id)
      .all<{ vector_id: string }>();

    const vectorIds = messages.results.map((m) => m.vector_id);

    // 2. Delete vectors from VEC_MESSAGES
    if (vectorIds.length > 0) {
      await vectorDelete(this.env.VEC_MESSAGES, vectorIds);
    }

    // 3. Delete messages first (no cascade in D1 by default), then the session
    await this.env.DB.batch([
      this.env.DB.prepare('DELETE FROM messages WHERE session_id = ?').bind(id),
      this.env.DB.prepare(
        'DELETE FROM sessions WHERE id = ? AND project_id = ? AND user_id = ?'
      ).bind(id, this.projectId, this.userId),
    ]);

    // 4. Invalidate KV cache
    await Promise.all([
      cacheDelete(this.env.CACHE, this.projectId, this.userId, `session:${id}:recent`),
      cacheDelete(this.env.CACHE, this.projectId, this.userId, `session:${id}:meta`),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  async addMessage(
    sessionId: string,
    role: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<MessageRow> {
    // 1. Verify session exists and belongs to this project
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found in project ${this.projectId}`);
    }

    // 2. Get next sequence_num
    const seqResult = await this.env.DB.prepare(
      'SELECT COALESCE(MAX(sequence_num), 0) + 1 AS next_seq FROM messages WHERE session_id = ?'
    )
      .bind(sessionId)
      .first<{ next_seq: number }>();

    const sequenceNum = seqResult?.next_seq ?? 1;

    // 3. Generate message ID
    const id = generateId();
    const now = new Date().toISOString();
    const metaJson = JSON.stringify(metadata ?? {});

    // 4. Generate embedding
    const embedding = await getEmbedding(content, this.env.AI);

    // 5. Insert message into D1
    await this.env.DB.prepare(
      'INSERT INTO messages (id, session_id, role, content, metadata, created_at, sequence_num, vector_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(id, sessionId, role, content, metaJson, now, sequenceNum, id)
      .run();

    // 6. Insert vector into Vectorize with scoped namespace
    await vectorInsert(this.env.VEC_MESSAGES, id, embedding, getWriteNamespace(this.projectId, this.userId), {
      session_id: sessionId,
      role,
    });

    // 7. Update session updated_at
    await this.env.DB.prepare(
      'UPDATE sessions SET updated_at = ? WHERE id = ?'
    )
      .bind(now, sessionId)
      .run();

    // 8. Invalidate KV cache for this session's recent messages
    await cacheDelete(
      this.env.CACHE,
      this.projectId,
      this.userId,
      `session:${sessionId}:recent`
    );

    // 9. Return the message row
    return {
      id,
      session_id: sessionId,
      role: role as MessageRow['role'],
      content,
      metadata: metaJson,
      created_at: now,
      sequence_num: sequenceNum,
      vector_id: id,
    };
  }

  async getConversation(
    sessionId: string,
    limit: number = 50
  ): Promise<MessageRow[]> {
    // Verify session belongs to this project
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found in project ${this.projectId}`);
    }

    // 1. Try KV cache first
    const cacheKey = `session:${sessionId}:recent`;
    const cached = await cacheGet<MessageRow[]>(
      this.env.CACHE,
      this.projectId,
      this.userId,
      cacheKey
    );

    if (cached) {
      return cached;
    }

    // 2. Query D1
    const result = await this.env.DB.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY sequence_num ASC LIMIT ?'
    )
      .bind(sessionId, limit)
      .all<MessageRow>();

    const messages = result.results;

    // 3. Cache the result with 60-second TTL
    await cacheSet(this.env.CACHE, this.projectId, this.userId, cacheKey, messages, 60);

    return messages;
  }

  async addMessagesBatch(
    sessionId: string,
    messages: AddMessageInput[],
    batchSize: number = 100
  ): Promise<number> {
    // 1. Verify session exists
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found in project ${this.projectId}`);
    }

    // 2. Get current max sequence_num
    const seqResult = await this.env.DB.prepare(
      'SELECT COALESCE(MAX(sequence_num), 0) AS max_seq FROM messages WHERE session_id = ?'
    )
      .bind(sessionId)
      .first<{ max_seq: number }>();

    let currentSeq = seqResult?.max_seq ?? 0;
    let totalInserted = 0;

    // 3. Process in batches
    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      const contents = batch.map((m) => m.content);

      // 3a. Generate embeddings for the entire batch
      const embeddings = await getEmbeddings(contents, this.env.AI);

      // 3b. Build D1 insert statements and vector inserts
      const now = new Date().toISOString();
      const d1Statements: D1PreparedStatement[] = [];
      const vectorPromises: Promise<void>[] = [];

      for (let j = 0; j < batch.length; j++) {
        const msg = batch[j]!;
        const embedding = embeddings[j]!;
        const id = generateId();
        currentSeq += 1;
        const metaJson = JSON.stringify(msg.metadata ?? {});

        d1Statements.push(
          this.env.DB.prepare(
            'INSERT INTO messages (id, session_id, role, content, metadata, created_at, sequence_num, vector_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(
            id,
            sessionId,
            msg.role,
            msg.content,
            metaJson,
            now,
            currentSeq,
            id
          )
        );

        vectorPromises.push(
          vectorInsert(this.env.VEC_MESSAGES, id, embedding, getWriteNamespace(this.projectId, this.userId), {
            session_id: sessionId,
            role: msg.role,
          })
        );
      }

      // 3c. Execute D1 batch and vector inserts
      await this.env.DB.batch(d1Statements);
      await Promise.all(vectorPromises);

      totalInserted += batch.length;
    }

    // 4. Update session updated_at
    const now = new Date().toISOString();
    await this.env.DB.prepare(
      'UPDATE sessions SET updated_at = ? WHERE id = ?'
    )
      .bind(now, sessionId)
      .run();

    // 5. Invalidate cache
    await cacheDelete(
      this.env.CACHE,
      this.projectId,
      this.userId,
      `session:${sessionId}:recent`
    );

    // 6. Return total count
    return totalInserted;
  }

  async searchMessages(
    query: string,
    opts?: { sessionId?: string; limit?: number }
  ): Promise<SearchResult[]> {
    const limit = opts?.limit ?? 10;

    // 1. Generate embedding for the query
    const embedding = await getEmbedding(query, this.env.AI);

    // 2. Cascading search across project + global namespaces
    const results = await cascadingSearch(
      this.env.VEC_MESSAGES,
      embedding,
      this.projectId,
      this.userId,
      limit
    );

    // 3. If sessionId filter is provided, filter to only matching results
    if (opts?.sessionId) {
      return results.filter(
        (r) => r.metadata?.session_id === opts.sessionId
      );
    }

    return results;
  }
}
