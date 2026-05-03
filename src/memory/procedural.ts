import type {
  Bindings,
  TraceRow,
  StepRow,
  ToolCallRow,
  ToolStatRow,
  SearchResult,
} from '../types';
import type {
  StartTraceInput,
  AddStepInput,
  RecordToolCallInput,
  TraceFilterInput,
} from '../utils/validation';
import { generateId } from '../utils/ids';
import { NotFoundError } from '../utils/errors';
import { parsePagination } from '../utils/pagination';
import { getEmbedding } from '../services/embeddings';
import { cacheGet, cacheSet, cacheDelete } from '../services/cache';
import { vectorInsert, vectorUpsert, cascadingSearch, getWriteNamespace } from '../services/vectorize';
import { publishEvent } from '../services/events';

export interface StepWithCalls extends StepRow {
  tool_calls: ToolCallRow[];
}

export interface TraceDetail {
  trace: TraceRow;
  steps: StepWithCalls[];
}

export class ProceduralMemory {
  constructor(
    private env: Bindings,
    private projectId: string,
    private userId: string = 'default'
  ) {}

  // ---------------------------------------------------------------------------
  // Traces
  // ---------------------------------------------------------------------------

  async startTrace(input: StartTraceInput): Promise<TraceRow> {
    const id = generateId();
    const now = new Date().toISOString();
    const metaJson = JSON.stringify(input.metadata ?? {});

    await this.env.DB.prepare(
      'INSERT INTO reasoning_traces (id, project_id, user_id, session_id, task, started_at, triggered_by_message_id, metadata, vector_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(
        id,
        this.projectId,
        this.userId,
        input.session_id ?? null,
        input.task,
        now,
        input.triggered_by_message_id ?? null,
        metaJson,
        id
      )
      .run();

    // Embed the task so in-flight traces are searchable. completeTrace
    // re-embeds with the richer task+outcome text once the trace closes.
    const embedding = await getEmbedding(input.task, this.env.AI);
    await vectorInsert(
      this.env.VEC_TRACES,
      id,
      embedding,
      getWriteNamespace(this.projectId, this.userId),
      { task: input.task, success: 'pending' }
    );

    const row: TraceRow = {
      id,
      project_id: this.projectId,
      user_id: this.userId,
      session_id: input.session_id ?? null,
      task: input.task,
      outcome: null,
      success: null,
      started_at: now,
      completed_at: null,
      duration_ms: null,
      triggered_by_message_id: input.triggered_by_message_id ?? null,
      metadata: metaJson,
      vector_id: id,
    };
    await publishEvent(this.env, this.projectId, this.userId, 'trace_started', {
      id: row.id,
      task: row.task,
      session_id: row.session_id,
      started_at: row.started_at,
    });
    return row;
  }

  async completeTrace(
    id: string,
    outcome: string,
    success: boolean
  ): Promise<TraceRow> {
    // 1. Get the existing trace
    const trace = await this.env.DB.prepare(
      'SELECT * FROM reasoning_traces WHERE id = ? AND project_id = ? AND user_id = ?'
    )
      .bind(id, this.projectId, this.userId)
      .first<TraceRow>();

    if (!trace) {
      throw new NotFoundError(`Trace ${id}`);
    }

    // 2. Calculate completion fields
    const completedAt = new Date().toISOString();
    const durationMs = Date.parse(completedAt) - Date.parse(trace.started_at);
    const successInt = success ? 1 : 0;

    // 3. Update the trace in D1
    await this.env.DB.prepare(
      'UPDATE reasoning_traces SET outcome = ?, success = ?, completed_at = ?, duration_ms = ?, vector_id = ? WHERE id = ? AND project_id = ? AND user_id = ?'
    )
      .bind(outcome, successInt, completedAt, durationMs, id, id, this.projectId, this.userId)
      .run();

    // 4. Re-embed with task + outcome for richer retrieval; upserts the
    // pending vector that startTrace inserted. Skip if outcome is empty.
    const embedText = outcome ? `${trace.task}\n${outcome}` : trace.task;
    const embedding = await getEmbedding(embedText, this.env.AI);
    await vectorUpsert(this.env.VEC_TRACES, id, embedding, getWriteNamespace(this.projectId, this.userId), {
      task: trace.task,
      success: String(success),
      duration_ms: String(durationMs),
      outcome: outcome.slice(0, 200),
      completed_at: completedAt,
    });

    // 5. Return the updated trace
    const row: TraceRow = {
      ...trace,
      outcome,
      success: successInt,
      completed_at: completedAt,
      duration_ms: durationMs,
      vector_id: id,
    };
    await publishEvent(this.env, this.projectId, this.userId, 'trace_completed', {
      id: row.id,
      task: row.task,
      outcome: row.outcome,
      success: row.success === 1,
      duration_ms: row.duration_ms,
    });
    return row;
  }

  async listTraces(opts?: TraceFilterInput): Promise<TraceRow[]> {
    const { limit, offset } = parsePagination(opts);

    // Build dynamic WHERE clause
    const conditions: string[] = ['project_id = ?', 'user_id = ?'];
    const bindings: (string | number)[] = [this.projectId, this.userId];

    if (opts?.session_id !== undefined) {
      conditions.push('session_id = ?');
      bindings.push(opts.session_id);
    }

    if (opts?.success !== undefined) {
      conditions.push('success = ?');
      bindings.push(opts.success ? 1 : 0);
    }

    const whereClause = conditions.join(' AND ');
    const query = `SELECT * FROM reasoning_traces WHERE ${whereClause} ORDER BY started_at DESC LIMIT ? OFFSET ?`;

    bindings.push(limit, offset);

    const result = await this.env.DB.prepare(query)
      .bind(...bindings)
      .all<TraceRow>();

    return result.results;
  }

  async searchTraces(
    query: string,
    limit: number = 10,
    precomputedEmbedding?: number[]
  ): Promise<SearchResult[]> {
    const embedding = precomputedEmbedding ?? (await getEmbedding(query, this.env.AI));
    return cascadingSearch(
      this.env.VEC_TRACES,
      embedding,
      this.projectId,
      this.userId,
      limit
    );
  }

  async getTraceDetail(id: string): Promise<TraceDetail | null> {
    const trace = await this.env.DB.prepare(
      `SELECT * FROM reasoning_traces
       WHERE id = ?
         AND project_id IN (?, 'global')
         AND user_id IN (?, 'global', 'default')`
    )
      .bind(id, this.projectId, this.userId)
      .first<TraceRow>();

    if (!trace) return null;

    const [stepsRes, toolCallsRes] = await Promise.all([
      this.env.DB.prepare(
        'SELECT * FROM reasoning_steps WHERE trace_id = ? ORDER BY step_number ASC'
      )
        .bind(id)
        .all<StepRow>(),
      this.env.DB.prepare(
        `SELECT tc.* FROM tool_calls tc
         JOIN reasoning_steps rs ON rs.id = tc.step_id
         WHERE rs.trace_id = ?
         ORDER BY tc.created_at ASC`
      )
        .bind(id)
        .all<ToolCallRow>(),
    ]);

    const callsByStep = new Map<string, ToolCallRow[]>();
    for (const call of toolCallsRes.results) {
      const list = callsByStep.get(call.step_id) ?? [];
      list.push(call);
      callsByStep.set(call.step_id, list);
    }

    const steps: StepWithCalls[] = stepsRes.results.map((step) => ({
      ...step,
      tool_calls: callsByStep.get(step.id) ?? [],
    }));

    return { trace, steps };
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  async addStep(traceId: string, input: AddStepInput): Promise<StepRow> {
    // 1. Verify trace belongs to this project
    const trace = await this.env.DB.prepare(
      'SELECT id FROM reasoning_traces WHERE id = ? AND project_id = ? AND user_id = ?'
    )
      .bind(traceId, this.projectId, this.userId)
      .first<{ id: string }>();

    if (!trace) {
      throw new NotFoundError(`Trace ${traceId}`);
    }

    // 2. Get next step_number
    const seqResult = await this.env.DB.prepare(
      'SELECT COALESCE(MAX(step_number), 0) + 1 AS next_step FROM reasoning_steps WHERE trace_id = ?'
    )
      .bind(traceId)
      .first<{ next_step: number }>();

    const stepNumber = seqResult?.next_step ?? 1;

    // 3. Insert the step
    const id = generateId();
    const now = new Date().toISOString();

    await this.env.DB.prepare(
      'INSERT INTO reasoning_steps (id, trace_id, step_number, thought, action, observation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(
        id,
        traceId,
        stepNumber,
        input.thought ?? null,
        input.action ?? null,
        input.observation ?? null,
        now
      )
      .run();

    return {
      id,
      trace_id: traceId,
      step_number: stepNumber,
      thought: input.thought ?? null,
      action: input.action ?? null,
      observation: input.observation ?? null,
      created_at: now,
    };
  }

  // ---------------------------------------------------------------------------
  // Tool Calls
  // ---------------------------------------------------------------------------

  async recordToolCall(
    stepId: string,
    input: RecordToolCallInput
  ): Promise<ToolCallRow> {
    // Verify step exists and belongs to a trace in this project
    const step = await this.env.DB.prepare(
      `SELECT rs.id FROM reasoning_steps rs
       JOIN reasoning_traces rt ON rs.trace_id = rt.id
       WHERE rs.id = ? AND rt.project_id = ? AND rt.user_id = ?`
    )
      .bind(stepId, this.projectId, this.userId)
      .first<{ id: string }>();

    if (!step) {
      throw new NotFoundError(`Step ${stepId}`);
    }

    const id = generateId();
    const now = new Date().toISOString();
    const argsJson = JSON.stringify(input.arguments ?? {});
    const resultJson =
      input.result !== undefined ? JSON.stringify(input.result) : null;

    // Use batch for atomicity: insert tool_call + upsert tool_stats
    const insertToolCall = this.env.DB.prepare(
      'INSERT INTO tool_calls (id, step_id, tool_name, arguments, result, status, duration_ms, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      id,
      stepId,
      input.tool_name,
      argsJson,
      resultJson,
      input.status,
      input.duration_ms ?? null,
      input.message_id ?? null,
      now
    );

    const successIncrement = input.status === 'success' ? 1 : 0;
    const failureIncrement = input.status === 'failure' ? 1 : 0;
    const durationIncrement = input.duration_ms ?? 0;

    const upsertToolStats = this.env.DB.prepare(
      `INSERT INTO tool_stats (tool_name, project_id, user_id, total_calls, success_count, failure_count, total_duration_ms, last_used_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(tool_name, project_id, user_id) DO UPDATE SET
         total_calls = total_calls + 1,
         success_count = success_count + ?,
         failure_count = failure_count + ?,
         total_duration_ms = total_duration_ms + ?,
         last_used_at = ?`
    ).bind(
      input.tool_name,
      this.projectId,
      this.userId,
      successIncrement,
      failureIncrement,
      durationIncrement,
      now,
      successIncrement,
      failureIncrement,
      durationIncrement,
      now
    );

    await this.env.DB.batch([insertToolCall, upsertToolStats]);

    // Invalidate tool_stats cache
    await cacheDelete(this.env.CACHE, this.projectId, this.userId, 'tool_stats');

    return {
      id,
      step_id: stepId,
      tool_name: input.tool_name,
      arguments: argsJson,
      result: resultJson,
      status: input.status,
      duration_ms: input.duration_ms ?? null,
      message_id: input.message_id ?? null,
      created_at: now,
    };
  }

  async getToolStats(): Promise<ToolStatRow[]> {
    // 1. Try KV cache
    const cached = await cacheGet<ToolStatRow[]>(
      this.env.CACHE,
      this.projectId,
      this.userId,
      'tool_stats'
    );

    if (cached) {
      return cached;
    }

    // 2. Query D1
    const result = await this.env.DB.prepare(
      'SELECT * FROM tool_stats WHERE project_id = ? AND user_id = ? ORDER BY total_calls DESC'
    )
      .bind(this.projectId, this.userId)
      .all<ToolStatRow>();

    const stats = result.results;

    // 3. Cache with 5-minute TTL
    await cacheSet(this.env.CACHE, this.projectId, this.userId, 'tool_stats', stats, 300);

    return stats;
  }
}
