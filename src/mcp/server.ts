import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z, ZodError } from 'zod';
import type { AppType, Bindings, SearchResult } from '../types';
import { ShortTermMemory } from '../memory/short-term';
import { LongTermMemory } from '../memory/long-term';
import { ProceduralMemory } from '../memory/procedural';
import { buildContext } from '../memory/context';
import { promote } from '../memory/promotion';
import { generateId } from '../utils/ids';
import { checkMcpMethodRate } from '../middleware/rate-limit';
import { logError } from '../services/logger';
import { SSE } from '../config';
import {
  AddMessageSchema,
  AddEntitySchema,
  AddPreferenceSchema,
  AddFactSchema,
  StartTraceSchema,
  CompleteTraceSchema,
  AddStepSchema,
  RecordToolCallSchema,
  PromoteRequestSchema,
  ContextRequestSchema,
  AddRelationSchema,
  TraverseRelationsSchema,
} from '../utils/validation';

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

interface McpRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// MCP Tool definitions
// ---------------------------------------------------------------------------

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'memory_add_message',
    description:
      'Append a message to a conversation session (short-term memory). Call this whenever the user shares context worth preserving across the session, or when the agent wants its own reply persisted. Requires an existing session — call memory_create_session first if none exists.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID to add the message to' },
        role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
        content: { type: 'string', description: 'Message content' },
        metadata: { type: 'object', description: 'Optional metadata' },
      },
      required: ['session_id', 'role', 'content'],
    },
  },
  {
    name: 'memory_search',
    description:
      'Search stored memories across types (messages, entities, preferences, facts, traces). CALL THIS WHENEVER the user says "recall", "what do you know about", "remember when", "have we discussed", or otherwise references prior context. Uses cascading semantic search across project and global scopes — prefer this over answering from conversation context alone when the user is invoking memory.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['messages', 'entities', 'preferences', 'facts', 'traces'] },
        },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_get_context',
    description:
      'Build a unified context block from all memory types (recent messages, entities, preferences, facts, past traces). CALL THIS FIRST at the start of any complex or multi-step task, before answering questions that depend on user history, and whenever entering a new session that may benefit from prior context. Cheaper than several individual searches when you need broad situational awareness.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        session_id: { type: 'string' },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['short_term', 'long_term', 'procedural'] },
        },
        limits: {
          type: 'object',
          properties: {
            messages: { type: 'number' },
            entities: { type: 'number' },
            preferences: { type: 'number' },
            facts: { type: 'number' },
            traces: { type: 'number' },
          },
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_add_entity',
    description:
      'Persist a named entity (person, place, organization, object, event, custom) to long-term memory. Call when the user introduces a stable proper-noun thing worth remembering across sessions ("my colleague Maria", "the Atlas project", "our staging cluster"). Runs entity resolution first — if a matching entity already exists in this project or global scope, the existing record is returned instead of creating a duplicate.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        entity_type: {
          type: 'string',
          enum: ['PERSON', 'OBJECT', 'LOCATION', 'EVENT', 'ORGANIZATION', 'CUSTOM'],
        },
        subtype: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['name', 'entity_type'],
    },
  },
  {
    name: 'memory_add_preference',
    description:
      'Save a user preference to long-term memory. CALL THIS WHENEVER the user says "remember", "save this", "store", "from now on", "I prefer", "always do X", or otherwise expresses a durable preference about how they want work done. Use category to group (e.g. "communication_style", "code_style", "tooling"). Prefer this over memory_add_fact when the statement is about how the user wants things done rather than an objective triple.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        preference: { type: 'string' },
        context: { type: 'string' },
      },
      required: ['category', 'preference'],
    },
  },
  {
    name: 'memory_add_fact',
    description:
      'Store an objective fact as a subject-predicate-object triple in long-term memory. CALL THIS WHENEVER the user shares a durable, verifiable piece of information ("Maria works at Acme", "the prod region is us-east-1", "the migration shipped on 2026-04-01"). Use memory_add_preference instead when the statement is about how the user wants things done. Optional valid_from/valid_until support time-bounded facts.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        predicate: { type: 'string' },
        object: { type: 'string' },
        valid_from: { type: 'string' },
        valid_until: { type: 'string' },
      },
      required: ['subject', 'predicate', 'object'],
    },
  },
  {
    name: 'memory_start_trace',
    description:
      'Open a reasoning trace (procedural memory) for a task the agent is about to execute. Call at the start of any non-trivial multi-step task so the steps and tool calls can be recorded for later replay/debugging. Pair with memory_add_step for each thought/action and memory_complete_trace at the end.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        session_id: { type: 'string' },
      },
      required: ['task'],
    },
  },
  {
    name: 'memory_promote_to_global',
    description:
      'Promote a project-scoped entity, preference, or fact so it is visible from every project. CALL THIS WHENEVER the user says "promote", "make this global", or otherwise asks for a memory to be shared across projects. The original project-scoped record stays in place — promotion is a copy, not a move — and an audit row is written to promotion_log. Set target="user" to scope to the user instead of fully global.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['entity', 'preference', 'fact'] },
        id: { type: 'string' },
        reason: { type: 'string' },
        target: { type: 'string', enum: ['user', 'global'] },
      },
      required: ['type', 'id', 'reason'],
    },
  },
  {
    name: 'memory_add_relation',
    description:
      'Record a directed edge between two entities in the knowledge graph (e.g. Alice "knows" Bob). Complements memory_add_fact: prefer a relation when you want to traverse it later, prefer a fact when you want a time-bounded triple.',
    inputSchema: {
      type: 'object',
      properties: {
        source_entity_id: {
          type: 'string',
          description: 'ID of the source entity (the edge origin).',
        },
        target_entity_id: {
          type: 'string',
          description: 'ID of the target entity (the edge destination).',
        },
        relation_type: {
          type: 'string',
          description:
            'Verb-like label for the edge, e.g. "knows", "works_at", "depends_on". Lowercase snake_case recommended.',
        },
        relation_strength: {
          type: 'number',
          description: 'Optional weight in [0, 1]. Re-asserting an edge updates this value.',
        },
        metadata: { type: 'object', description: 'Optional arbitrary metadata.' },
      },
      required: ['source_entity_id', 'target_entity_id', 'relation_type'],
    },
  },
  {
    name: 'memory_create_session',
    description:
      'Create a short-term memory session to group messages. Call this before memory_add_message — a session must exist. If id is omitted a random id is generated and returned.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Optional session ID. Must be 1–500 chars. Omit to let the server generate one.',
        },
        metadata: { type: 'object', description: 'Optional metadata (purpose, caller, etc.).' },
      },
    },
  },
  {
    name: 'memory_complete_trace',
    description:
      'Mark a reasoning trace as finished. Records the outcome text, success flag, and end timestamp so duration_ms is populated. Pairs with memory_start_trace.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Trace ID returned by memory_start_trace.' },
        outcome: {
          type: 'string',
          description: 'Short free-text summary of how the task ended (what was decided, found, or shipped).',
        },
        success: {
          type: 'boolean',
          description: 'true if the trace achieved its task, false otherwise.',
        },
      },
      required: ['id', 'outcome', 'success'],
    },
  },
  {
    name: 'memory_add_step',
    description:
      'Append a reasoning step to an open trace. Each step captures a thought/action/observation triple and is auto-numbered. Call after memory_start_trace and before memory_complete_trace. Required context for memory_record_tool_call.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string', description: 'Trace ID returned by memory_start_trace.' },
        thought: { type: 'string', description: 'What the agent is reasoning about.' },
        action: { type: 'string', description: 'What the agent decided to do.' },
        observation: { type: 'string', description: 'What the agent observed after acting.' },
      },
      required: ['trace_id'],
    },
  },
  {
    name: 'memory_record_tool_call',
    description:
      'Attach a tool call to an existing step. Captures tool_name, arguments, result, status (success/failure/timeout), and duration_ms. Also upserts into tool_stats, so the Observatory tool-instruments panel fills in as calls accumulate.',
    inputSchema: {
      type: 'object',
      properties: {
        step_id: { type: 'string', description: 'Step ID returned by memory_add_step.' },
        tool_name: { type: 'string', description: 'Name of the tool that was called.' },
        arguments: { type: 'object', description: 'Arguments passed to the tool (any JSON-serialisable object).' },
        result: { description: 'The return value from the tool (any JSON-serialisable value).' },
        status: { type: 'string', enum: ['success', 'failure', 'timeout'] },
        duration_ms: { type: 'number', description: 'How long the call took in milliseconds.' },
        message_id: { type: 'string', description: 'Optional message id the call was triggered by.' },
      },
      required: ['step_id', 'tool_name', 'status'],
    },
  },
  {
    name: 'memory_traverse',
    description:
      'Walk the knowledge graph outward from a root entity. Returns each reachable entity once with its minimum hop distance. Use when semantic search is not enough and you need entities connected by specific relations.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Root entity to walk from.' },
        max_depth: {
          type: 'number',
          description: 'Hop count limit (1-4). Default 2.',
        },
        direction: {
          type: 'string',
          enum: ['out', 'in', 'both'],
          description:
            'Edge direction relative to root. "out" follows outgoing edges, "in" incoming, "both" ignores direction. Default "both".',
        },
        relation_types: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional allow-list of relation_type labels. When present, branches that do not match are pruned during recursion.',
        },
        limit: {
          type: 'number',
          description: 'Max entities returned (1-200). Default 50.',
        },
      },
      required: ['entity_id'],
    },
  },
];

// ---------------------------------------------------------------------------
// MCP Prompt definitions
//
// Prompts are how MCP carries slash-command-style entry points to clients
// that don't read CLAUDE.md (Zed/ACP, Cursor, etc). Each prompt expands into
// one or more user/assistant messages that steer the model toward the right
// memory tool — they don't call tools directly. Clients typically surface
// these as `/<server>:<prompt>` slash commands.
// ---------------------------------------------------------------------------

interface McpPromptArgument {
  name: string;
  description: string;
  required: boolean;
}

interface McpPromptDefinition {
  name: string;
  description: string;
  arguments: McpPromptArgument[];
}

const PROMPT_DEFINITIONS: McpPromptDefinition[] = [
  {
    name: 'remember',
    description:
      'Persist information to long-term memory. Routes to memory_add_preference, memory_add_fact, or memory_add_entity depending on the content.',
    arguments: [
      {
        name: 'content',
        description: 'The information to remember (a preference, a fact, or an entity description).',
        required: true,
      },
    ],
  },
  {
    name: 'recall',
    description:
      'Retrieve relevant memories for a query via cascading search across project and global scopes.',
    arguments: [
      {
        name: 'query',
        description: 'What to look up. Free text — semantic search will match against stored memories.',
        required: true,
      },
    ],
  },
  {
    name: 'context',
    description:
      'Build a unified context block (recent conversation, entities, preferences, facts, past traces) for a given query. Use at the start of complex tasks.',
    arguments: [
      {
        name: 'query',
        description: 'The task or question to gather context for.',
        required: true,
      },
    ],
  },
  {
    name: 'promote',
    description:
      'Promote a project-scoped memory to global scope so it is visible across all projects. Requires the memory id and a reason.',
    arguments: [
      {
        name: 'type',
        description: 'One of "entity", "preference", or "fact".',
        required: true,
      },
      {
        name: 'id',
        description: 'The memory id to promote.',
        required: true,
      },
      {
        name: 'reason',
        description: 'Short justification for promotion (recorded in the audit log).',
        required: true,
      },
    ],
  },
];

interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

function buildPromptMessages(name: string, args: Record<string, string>): McpPromptMessage[] {
  switch (name) {
    case 'remember': {
      const content = args['content'] ?? '';
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Persist the following to long-term memory using the most appropriate cf-agent-memory tool ` +
              `(memory_add_preference for "I prefer / from now on / always" style guidance, ` +
              `memory_add_fact for objective subject-predicate-object triples, ` +
              `memory_add_entity for named people/places/orgs/objects). ` +
              `Do not respond from conversation context alone — make the tool call.\n\n` +
              `Content to remember:\n${content}`,
          },
        },
      ];
    }
    case 'recall': {
      const query = args['query'] ?? '';
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Retrieve relevant memories for the following query by calling memory_search ` +
              `(or memory_get_context if the task warrants a unified block). ` +
              `Do not answer from conversation context alone — make the tool call first, then summarize the results.\n\n` +
              `Query: ${query}`,
          },
        },
      ];
    }
    case 'context': {
      const query = args['query'] ?? '';
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Call memory_get_context with the following query, then use the returned block to inform your subsequent work. ` +
              `Do not skip the tool call.\n\n` +
              `Query: ${query}`,
          },
        },
      ];
    }
    case 'promote': {
      const type = args['type'] ?? '';
      const id = args['id'] ?? '';
      const reason = args['reason'] ?? '';
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Call memory_promote_to_global with type="${type}", id="${id}", reason="${reason}". ` +
              `Confirm the promotion result to the user.`,
          },
        },
      ];
    }
    default:
      throw new InvalidParamsError(`Unknown prompt: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Zod schemas for MCP args — reuse REST schemas where possible.
// ---------------------------------------------------------------------------

const AddMessageMcpSchema = AddMessageSchema.extend({
  session_id: z.string().min(1).max(500),
});

const SearchMcpSchema = z.object({
  query: z.string().min(1),
  types: z.array(z.enum(['messages', 'entities', 'preferences', 'facts', 'traces'])).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const AddRelationMcpSchema = AddRelationSchema.extend({
  source_entity_id: z.string().min(1).max(500),
});

const TraverseMcpSchema = TraverseRelationsSchema.extend({
  entity_id: z.string().min(1).max(500),
});

// Session id is optional at the MCP boundary (we generate one when
// absent), so we can't reuse CreateSessionSchema directly.
const CreateSessionMcpSchema = z.object({
  id: z.string().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const CompleteTraceMcpSchema = CompleteTraceSchema.extend({
  id: z.string().min(1).max(500),
});

const AddStepMcpSchema = AddStepSchema.extend({
  trace_id: z.string().min(1).max(500),
});

const RecordToolCallMcpSchema = RecordToolCallSchema.extend({
  step_id: z.string().min(1).max(500),
});

function parseArgs<T>(schema: z.ZodType<T>, args: Record<string, unknown>): T {
  try {
    return schema.parse(args);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new InvalidParamsError(err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    throw err;
  }
}

function toolResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

class InvalidParamsError extends Error {
  code = -32602;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidParamsError';
  }
}

// ---------------------------------------------------------------------------
// Tool call dispatcher
// ---------------------------------------------------------------------------

async function dispatchToolCall(
  env: Bindings,
  projectId: string,
  userId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    case 'memory_add_message': {
      const parsed = parseArgs(AddMessageMcpSchema, args);
      return stm(env, projectId, userId).addMessage(
        parsed.session_id,
        parsed.role,
        parsed.content,
        parsed.metadata
      );
    }

    case 'memory_search': {
      const parsed = parseArgs(SearchMcpSchema, args);
      const limit = parsed.limit ?? 10;
      const types = parsed.types ?? ['messages', 'entities', 'preferences', 'facts', 'traces'];

      const results: Record<string, SearchResult[]> = {};
      const jobs: Array<Promise<void>> = [];

      if (types.includes('messages')) {
        jobs.push(stm(env, projectId, userId).searchMessages(parsed.query, { limit }).then((r) => {
          results['messages'] = r;
        }));
      }
      if (types.includes('entities')) {
        jobs.push(ltm(env, projectId, userId).searchEntities(parsed.query, limit).then((r) => {
          results['entities'] = r;
        }));
      }
      if (types.includes('preferences')) {
        jobs.push(ltm(env, projectId, userId).searchPreferences(parsed.query, limit).then((r) => {
          results['preferences'] = r;
        }));
      }
      if (types.includes('facts')) {
        jobs.push(ltm(env, projectId, userId).searchFacts(parsed.query, limit).then((r) => {
          results['facts'] = r;
        }));
      }
      if (types.includes('traces')) {
        jobs.push(pm(env, projectId, userId).searchTraces(parsed.query, limit).then((r) => {
          results['traces'] = r;
        }));
      }

      await Promise.all(jobs);
      return results;
    }

    case 'memory_get_context': {
      const parsed = parseArgs(ContextRequestSchema, args);
      const result = await buildContext(env, projectId, userId, parsed);
      return result.errors.length > 0
        ? { context: result.context, errors: result.errors }
        : { context: result.context };
    }

    case 'memory_add_entity': {
      const parsed = parseArgs(AddEntitySchema, args);
      return ltm(env, projectId, userId).addEntity(parsed);
    }

    case 'memory_add_preference': {
      const parsed = parseArgs(AddPreferenceSchema, args);
      return ltm(env, projectId, userId).addPreference(parsed);
    }

    case 'memory_add_fact': {
      const parsed = parseArgs(AddFactSchema, args);
      return ltm(env, projectId, userId).addFact(parsed);
    }

    case 'memory_start_trace': {
      const parsed = parseArgs(StartTraceSchema, args);
      return pm(env, projectId, userId).startTrace(parsed);
    }

    case 'memory_complete_trace': {
      const parsed = parseArgs(CompleteTraceMcpSchema, args);
      return pm(env, projectId, userId).completeTrace(parsed.id, parsed.outcome, parsed.success);
    }

    case 'memory_create_session': {
      const parsed = parseArgs(CreateSessionMcpSchema, args);
      const id = parsed.id ?? generateId();
      return stm(env, projectId, userId).createSession(id, parsed.metadata);
    }

    case 'memory_add_step': {
      const parsed = parseArgs(AddStepMcpSchema, args);
      return pm(env, projectId, userId).addStep(parsed.trace_id, {
        thought: parsed.thought,
        action: parsed.action,
        observation: parsed.observation,
      });
    }

    case 'memory_record_tool_call': {
      const parsed = parseArgs(RecordToolCallMcpSchema, args);
      return pm(env, projectId, userId).recordToolCall(parsed.step_id, {
        tool_name: parsed.tool_name,
        arguments: parsed.arguments ?? {},
        result: parsed.result,
        status: parsed.status,
        duration_ms: parsed.duration_ms,
        message_id: parsed.message_id,
      });
    }

    case 'memory_promote_to_global': {
      const parsed = parseArgs(PromoteRequestSchema, args);
      return promote(env, projectId, userId, parsed.type, parsed.id, parsed.reason, parsed.target ?? 'global');
    }

    case 'memory_add_relation': {
      const parsed = parseArgs(AddRelationMcpSchema, args);
      return ltm(env, projectId, userId).addRelation(
        parsed.source_entity_id,
        parsed.target_entity_id,
        parsed.relation_type,
        parsed.metadata,
        parsed.relation_strength
      );
    }

    case 'memory_traverse': {
      const parsed = parseArgs(TraverseMcpSchema, args);
      return ltm(env, projectId, userId).traverseRelations(parsed.entity_id, {
        maxDepth: parsed.max_depth,
        relationTypes: parsed.relation_types,
        direction: parsed.direction,
        limit: parsed.limit,
      });
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

const stm = (env: Bindings, p: string, u: string) => new ShortTermMemory(env, p, u);
const ltm = (env: Bindings, p: string, u: string) => new LongTermMemory(env, p, u);
const pm = (env: Bindings, p: string, u: string) => new ProceduralMemory(env, p, u);

// ---------------------------------------------------------------------------
// JSON-RPC response builders
// ---------------------------------------------------------------------------

function jsonRpcResult(id: string | number, result: unknown): McpResponse {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: string | number, code: number, message: string): McpResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Hono sub-app
// ---------------------------------------------------------------------------

const mcp = new Hono<AppType>();

mcp.get('/', (c) => c.text('Method Not Allowed', 405));

mcp.post('/', async (c) => {
  let body: Record<string, unknown>;

  try {
    const raw: unknown = await c.req.json();
    if (typeof raw !== 'object' || raw === null || !('jsonrpc' in raw) || !('method' in raw)) {
      return c.json(jsonRpcError(0, -32600, 'Invalid JSON-RPC request'), 400);
    }
    body = raw as Record<string, unknown>;
  } catch {
    return c.json(jsonRpcError(0, -32700, 'Parse error'), 400);
  }

  const method = body['method'] as string;

  if (!('id' in body)) {
    return c.body(null, 204);
  }

  const id = body['id'] as string | number;
  const request: McpRequest = {
    jsonrpc: '2.0',
    id,
    method,
    params: body['params'] as Record<string, unknown> | undefined,
  };

  try {
    switch (method) {
      case 'initialize': {
        const sessionId = generateId();
        c.header('Mcp-Session-Id', sessionId);
        return c.json(
          jsonRpcResult(id, {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {}, prompts: {} },
            serverInfo: { name: 'cf-agent-memory', version: '0.1.0' },
          })
        );
      }

      case 'tools/list':
        return c.json(jsonRpcResult(id, { tools: TOOL_DEFINITIONS }));

      case 'prompts/list':
        return c.json(jsonRpcResult(id, { prompts: PROMPT_DEFINITIONS }));

      case 'prompts/get': {
        const params = request.params;
        if (!params || typeof params['name'] !== 'string') {
          return c.json(jsonRpcError(id, -32602, 'Invalid params: missing prompt name'), 400);
        }
        const promptName = params['name'];
        const rawArgs = params['arguments'];
        const promptArgs: Record<string, string> = {};
        if (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)) {
          for (const [k, v] of Object.entries(rawArgs as Record<string, unknown>)) {
            if (typeof v === 'string') promptArgs[k] = v;
          }
        }
        const def = PROMPT_DEFINITIONS.find((p) => p.name === promptName);
        if (!def) {
          return c.json(jsonRpcError(id, -32602, `Unknown prompt: ${promptName}`), 400);
        }
        for (const arg of def.arguments) {
          if (arg.required && !promptArgs[arg.name]) {
            return c.json(jsonRpcError(id, -32602, `Missing required argument: ${arg.name}`), 400);
          }
        }
        try {
          const messages = buildPromptMessages(promptName, promptArgs);
          return c.json(jsonRpcResult(id, { description: def.description, messages }));
        } catch (err: unknown) {
          if (err instanceof InvalidParamsError) {
            return c.json(jsonRpcError(id, err.code, err.message), 400);
          }
          throw err;
        }
      }

      case 'tools/call': {
        const params = request.params;
        if (!params || typeof params['name'] !== 'string') {
          return c.json(jsonRpcError(id, -32602, 'Invalid params: missing tool name'), 400);
        }

        const toolName = params['name'];
        const toolArgs =
          typeof params['arguments'] === 'object' &&
          params['arguments'] !== null &&
          !Array.isArray(params['arguments'])
            ? (params['arguments'] as Record<string, unknown>)
            : {};

        const rateOk = await checkMcpMethodRate(
          c.env.RL_MCP,
          c.get('projectId'),
          c.get('userId'),
          toolName
        );
        if (!rateOk) {
          return c.json(jsonRpcError(id, -32000, `Rate limit exceeded for ${toolName}`), 429);
        }

        try {
          const result = await dispatchToolCall(c.env, c.get('projectId'), c.get('userId'), toolName, toolArgs);
          return c.json(jsonRpcResult(id, toolResult(result)));
        } catch (err: unknown) {
          if (err instanceof InvalidParamsError) {
            return c.json(jsonRpcError(id, err.code, err.message), 400);
          }
          if (err instanceof Error && err.message.startsWith('Unknown tool:')) {
            return c.json(jsonRpcError(id, -32602, err.message), 400);
          }
          logError('mcp_tool_call_failed', err, {
            component: 'mcp',
            tool_name: toolName,
            project_id: c.get('projectId'),
            user_id: c.get('userId'),
          });
          const errMessage = err instanceof Error ? err.message : 'Internal error';
          return c.json(jsonRpcError(id, -32603, errMessage), 500);
        }
      }

      default:
        return c.json(jsonRpcError(id, -32601, 'Method not found'), 400);
    }
  } catch (err: unknown) {
    logError('mcp_request_failed', err, { component: 'mcp' });
    const errMessage = err instanceof Error ? err.message : 'Internal server error';
    return c.json(jsonRpcError(id, -32603, errMessage), 500);
  }
});

/**
 * GET /mcp/sse — SSE transport endpoint.
 * Sends an endpoint event then pings until MAX_DURATION_MS.
 */
mcp.get('/sse', async (c) => {
  const sessionId = generateId();
  const url = new URL(c.req.url);
  const postEndpoint = `${url.protocol}//${url.host}/mcp?sessionId=${sessionId}`;

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'endpoint', data: postEndpoint });

    const startTime = Date.now();
    while (Date.now() - startTime < SSE.maxDurationMs) {
      await stream.sleep(SSE.pingIntervalMs);
      await stream.writeSSE({ event: 'ping', data: new Date().toISOString() });
    }
  });
});

export default mcp;
