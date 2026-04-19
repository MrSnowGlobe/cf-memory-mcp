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
import { SSE } from '../config';
import {
  AddMessageSchema,
  AddEntitySchema,
  AddPreferenceSchema,
  AddFactSchema,
  StartTraceSchema,
  CompleteTraceSchema,
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
    description: 'Add a message to a conversation session in short-term memory.',
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
      'Search across memory types (messages, entities, preferences, facts, traces). Uses cascading search across project and global scopes.',
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
      'Build a unified context string from all memory types for a given query. Returns formatted text with recent conversation, entities, preferences, facts, and past traces.',
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
    description: 'Add an entity to long-term memory. Runs entity resolution first to prevent duplicates.',
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
    description: 'Store a user preference in long-term memory.',
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
    description: 'Store a fact as a subject-predicate-object triple in long-term memory.',
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
    description: 'Start a new reasoning trace in procedural memory to track a task execution.',
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
      'Promote a project-scoped entity, preference, or fact to global scope so it is visible across all projects.',
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
      const context = await buildContext(env, projectId, userId, parsed);
      return { context };
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
            capabilities: { tools: {} },
            serverInfo: { name: 'cf-agent-memory', version: '0.1.0' },
          })
        );
      }

      case 'tools/list':
        return c.json(jsonRpcResult(id, { tools: TOOL_DEFINITIONS }));

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
          console.error('[mcp] tool call failed:', err);
          const errMessage = err instanceof Error ? err.message : 'Internal error';
          return c.json(jsonRpcError(id, -32603, errMessage), 500);
        }
      }

      default:
        return c.json(jsonRpcError(id, -32601, 'Method not found'), 400);
    }
  } catch (err: unknown) {
    console.error('[mcp] request failed:', err);
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
