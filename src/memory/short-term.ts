import type {
  Bindings,
  SessionRow,
  MessageRow,
  SearchResult,
  PaginationOpts,
} from '../types';
import type { AddMessageInput } from '../utils/validation';
import { generateId } from '../utils/ids';
import { NotFoundError } from '../utils/errors';
import { parsePagination } from '../utils/pagination';
import { getEmbedding, getEmbeddings, getEmbeddingCached } from '../services/embeddings';
import { cacheGet, cacheSet, cacheDelete } from '../services/cache';
import {
  vectorInsert,
  vectorInsertMany,
  vectorDelete,
  cascadingSearch,
  getWriteNamespace,
} from '../services/vectorize';
import { publishEvent } from '../services/events';
import { logError } from '../services/logger';

export class ShortTermMemory {
  constructor(
    private env: Bindings,
    private projectId: string,
    private userId: string = 'default',
    // Optional — when present (set by route factories from c.executionCtx),
    // non-critical follow-up writes are deferred so they don't block the
    // user response. Tests and non-Worker contexts omit it and writes
    // execute inline.
    private waitUntil?: (promise: Promise<unknown>) => void
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
    const id = generateId();
    const now = new Date().toISOString();
    const metaJson = JSON.stringify(metadata ?? {});

    // Embedding and the scoped insert are independent — run in parallel
    // so Workers AI latency overlaps with D1.
    const [embedding, sequenceNum] = await Promise.all([
      getEmbedding(content, this.env.AI),
      this.insertMessageScoped(id, sessionId, role, content, metaJson, now),
    ]);

    // Vector insert + cache invalidation must complete before responding —
    // searches immediately after must see the new message and stale cache
    // would return without it. The session updated_at bump is purely a
    // sort-order signal for sessions list, so we defer it via waitUntil
    // when running in a Worker (falls through to inline await in tests).
    const sessionBump = this.env.DB.prepare(
      'UPDATE sessions SET updated_at = ? WHERE id = ?'
    )
      .bind(now, sessionId)
      .run();
    if (this.waitUntil) {
      this.waitUntil(sessionBump);
    }

    try {
      const critical: Promise<unknown>[] = [
        vectorInsert(
          this.env.VEC_MESSAGES,
          id,
          embedding,
          getWriteNamespace(this.projectId, this.userId),
          { session_id: sessionId, role }
        ),
        cacheDelete(
          this.env.CACHE,
          this.projectId,
          this.userId,
          `session:${sessionId}:recent`
        ),
      ];
      if (!this.waitUntil) critical.push(sessionBump);
      await Promise.all(critical);
    } catch (err) {
      logError('post_insert_side_effect_failed', err, {
        component: 'short-term',
        message_id: id,
        session_id: sessionId,
        project_id: this.projectId,
        user_id: this.userId,
      });
      throw err;
    }

    const row: MessageRow = {
      id,
      session_id: sessionId,
      role: role as MessageRow['role'],
      content,
      metadata: metaJson,
      created_at: now,
      sequence_num: sequenceNum,
      vector_id: id,
    };
    await publishEvent(this.env, this.projectId, this.userId, 'message_added', {
      id: row.id,
      session_id: row.session_id,
      role: row.role,
      content: row.content,
      created_at: row.created_at,
    });
    return row;
  }

  async getConversation(
    sessionId: string,
    limit: number = 50
  ): Promise<MessageRow[]> {
    // Cache key is already prefixed with {projectId}:{userId}:, so a hit
    // is implicitly scope-validated. Skip the D1 session lookup on the hot path.
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

    // Cache miss: validate session ownership and load from D1 in parallel.
    // If validation fails we throw and the (possibly empty) D1 read is wasted —
    // acceptable cost since the hot path is the cache hit above.
    const [session, result] = await Promise.all([
      this.getSession(sessionId),
      this.env.DB.prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY sequence_num ASC LIMIT ?'
      )
        .bind(sessionId, limit)
        .all<MessageRow>(),
    ]);

    if (!session) {
      throw new NotFoundError(`Session ${sessionId}`);
    }

    const messages = result.results;
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
      throw new NotFoundError(`Session ${sessionId}`);
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

      // 3b. Build D1 insert statements and vector payload
      const now = new Date().toISOString();
      const namespace = getWriteNamespace(this.projectId, this.userId);
      const d1Statements: D1PreparedStatement[] = [];
      const vectors: Array<{
        id: string;
        values: number[];
        namespace: string;
        metadata: Record<string, string>;
      }> = [];

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

        vectors.push({
          id,
          values: embedding,
          namespace,
          metadata: { session_id: sessionId, role: msg.role },
        });
      }

      // 3c. Execute D1 batch and a single Vectorize batch insert in parallel
      await Promise.all([
        this.env.DB.batch(d1Statements),
        vectorInsertMany(this.env.VEC_MESSAGES, vectors),
      ]);

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
    opts?: { sessionId?: string; limit?: number; embedding?: number[] }
  ): Promise<SearchResult[]> {
    const limit = opts?.limit ?? 10;
    // Callers that bulk-search across memory types (e.g. buildContext)
    // can pass a precomputed embedding to share one Workers AI call
    // across all queries; standalone callers fall through to the
    // KV-backed cache so repeat queries skip Workers AI altogether.
    const embedding =
      opts?.embedding ??
      (await getEmbeddingCached(query, this.env.AI, this.env.CACHE));

    const filter = opts?.sessionId ? { session_id: opts.sessionId } : undefined;

    return cascadingSearch(
      this.env.VEC_MESSAGES,
      embedding,
      this.projectId,
      this.userId,
      limit,
      filter ? { filter } : undefined
    );
  }

  // Atomic insert that computes sequence_num and validates session scope in a
  // single statement. The MAX subquery runs under SQLite's write lock so the
  // value is fresh; the scoped JOIN ensures the session belongs to this
  // project+user (no separate getSession round-trip needed). On UNIQUE
  // collision (rare contention), we retry once.
  private async insertMessageScoped(
    id: string,
    sessionId: string,
    role: string,
    content: string,
    metaJson: string,
    now: string
  ): Promise<number> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const result = await this.env.DB.prepare(
          `INSERT INTO messages (id, session_id, role, content, metadata, created_at, sequence_num, vector_id)
           SELECT ?, s.id, ?, ?, ?, ?,
                  COALESCE((SELECT MAX(sequence_num) FROM messages WHERE session_id = s.id), 0) + 1,
                  ?
           FROM sessions s
           WHERE s.id = ? AND s.project_id = ? AND s.user_id = ?
           RETURNING sequence_num`
        )
          .bind(id, role, content, metaJson, now, id, sessionId, this.projectId, this.userId)
          .first<{ sequence_num: number }>();

        if (!result) {
          throw new NotFoundError(`Session ${sessionId}`);
        }
        return result.sequence_num;
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('UNIQUE constraint') && attempt < MAX_ATTEMPTS - 1) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Failed to insert message after ${MAX_ATTEMPTS} attempts`);
  }
}
