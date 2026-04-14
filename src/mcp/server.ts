import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppType, Bindings, SearchResult, ContextInput } from '../types';
import { ShortTermMemory } from '../memory/short-term';
import { LongTermMemory } from '../memory/long-term';
import { ProceduralMemory } from '../memory/procedural';
import { buildContext } from '../memory/context';
import { promote } from '../memory/promotion';
import { generateId } from '../utils/ids';

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
      'Add a message to a conversation session in short-term memory.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID to add the message to' },
        role: {
          type: 'string',
          enum: ['user', 'assistant', 'system', 'tool'],
          description: 'Role of the message sender',
        },
        content: { type: 'string', description: 'Message content' },
        metadata: {
          type: 'object',
          description: 'Optional metadata to attach to the message',
        },
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
        query: { type: 'string', description: 'Search query text' },
        types: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['messages', 'entities', 'preferences', 'facts', 'traces'],
          },
          description:
            'Memory types to search. Defaults to all types if omitted.',
        },
        limit: {
          type: 'number',
          description: 'Maximum results per type (default: 10)',
        },
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
        query: { type: 'string', description: 'Context query text' },
        session_id: {
          type: 'string',
          description: 'Optional session ID for recent conversation',
        },
        include: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['short_term', 'long_term', 'procedural'],
          },
          description: 'Memory subsystems to include (default: all)',
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
          description: 'Per-type result limits',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_add_entity',
    description:
      'Add an entity to long-term memory. Runs entity resolution first to prevent duplicates.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Entity name' },
        entity_type: {
          type: 'string',
          enum: [
            'PERSON',
            'OBJECT',
            'LOCATION',
            'EVENT',
            'ORGANIZATION',
            'CUSTOM',
          ],
          description: 'Type of entity',
        },
        subtype: { type: 'string', description: 'Optional entity subtype' },
        description: {
          type: 'string',
          description: 'Optional entity description',
        },
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
        category: {
          type: 'string',
          description: 'Preference category (e.g. "coding_style", "language")',
        },
        preference: {
          type: 'string',
          description: 'The preference value',
        },
        context: {
          type: 'string',
          description: 'Optional context in which the preference applies',
        },
      },
      required: ['category', 'preference'],
    },
  },
  {
    name: 'memory_add_fact',
    description:
      'Store a fact as a subject-predicate-object triple in long-term memory.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Fact subject' },
        predicate: { type: 'string', description: 'Fact predicate / relation' },
        object: { type: 'string', description: 'Fact object' },
        valid_from: {
          type: 'string',
          description: 'ISO 8601 start of validity (optional)',
        },
        valid_until: {
          type: 'string',
          description: 'ISO 8601 end of validity (optional)',
        },
      },
      required: ['subject', 'predicate', 'object'],
    },
  },
  {
    name: 'memory_start_trace',
    description:
      'Start a new reasoning trace in procedural memory to track a task execution.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Description of the task being traced',
        },
        session_id: {
          type: 'string',
          description: 'Optional session ID to associate with',
        },
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
        type: {
          type: 'string',
          enum: ['entity', 'preference', 'fact'],
          description: 'Type of record to promote',
        },
        id: { type: 'string', description: 'ID of the record to promote' },
        reason: {
          type: 'string',
          description: 'Reason for promotion (audit trail)',
        },
        target: {
          type: 'string',
          enum: ['user', 'global'],
          description:
            "Promotion target scope: 'user' (visible across your projects) or 'global' (visible to all users). Defaults to 'global'.",
        },
      },
      required: ['type', 'id', 'reason'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool dispatch helpers
// ---------------------------------------------------------------------------

/**
 * Wraps a tool result in the MCP content format.
 */
function toolResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

/**
 * Extract a required string parameter or throw a readable error.
 */
function requireString(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new InvalidParamsError(`Missing or invalid required parameter: ${key}`);
  }
  return val;
}

/**
 * Extract an optional string parameter.
 */
function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') {
    throw new InvalidParamsError(`Parameter '${key}' must be a string`);
  }
  return val;
}

/**
 * Extract an optional number parameter.
 */
function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'number') {
    throw new InvalidParamsError(`Parameter '${key}' must be a number`);
  }
  return val;
}

/**
 * Extract an optional string array parameter.
 */
function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (!Array.isArray(val)) {
    throw new InvalidParamsError(`Parameter '${key}' must be an array`);
  }
  for (const item of val) {
    if (typeof item !== 'string') {
      throw new InvalidParamsError(`All items in '${key}' must be strings`);
    }
  }
  return val as string[];
}

/**
 * Extract an optional object parameter.
 */
function optionalObject(
  args: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'object' || Array.isArray(val)) {
    throw new InvalidParamsError(`Parameter '${key}' must be an object`);
  }
  return val as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Error classes for JSON-RPC error codes
// ---------------------------------------------------------------------------

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
    // ----- memory_add_message -----
    case 'memory_add_message': {
      const sessionId = requireString(args, 'session_id');
      const role = requireString(args, 'role');
      const content = requireString(args, 'content');
      const metadata = optionalObject(args, 'metadata');

      const mem = new ShortTermMemory(env, projectId, userId);
      const message = await mem.addMessage(
        sessionId,
        role,
        content,
        metadata
      );
      return message;
    }

    // ----- memory_search -----
    case 'memory_search': {
      const query = requireString(args, 'query');
      const types = optionalStringArray(args, 'types');
      const limit = optionalNumber(args, 'limit') ?? 10;

      const searchTypes = types ?? [
        'messages',
        'entities',
        'preferences',
        'facts',
        'traces',
      ];

      const results: Record<string, SearchResult[]> = {};

      const promises: Array<Promise<void>> = [];

      if (searchTypes.includes('messages')) {
        const mem = new ShortTermMemory(env, projectId, userId);
        promises.push(
          mem.searchMessages(query, { limit }).then((r) => {
            results['messages'] = r;
          })
        );
      }

      if (searchTypes.includes('entities')) {
        const mem = new LongTermMemory(env, projectId, userId);
        promises.push(
          mem.searchEntities(query, limit).then((r) => {
            results['entities'] = r;
          })
        );
      }

      if (searchTypes.includes('preferences')) {
        const mem = new LongTermMemory(env, projectId, userId);
        promises.push(
          mem.searchPreferences(query, limit).then((r) => {
            results['preferences'] = r;
          })
        );
      }

      if (searchTypes.includes('facts')) {
        const mem = new LongTermMemory(env, projectId, userId);
        promises.push(
          mem.searchFacts(query, limit).then((r) => {
            results['facts'] = r;
          })
        );
      }

      if (searchTypes.includes('traces')) {
        const mem = new ProceduralMemory(env, projectId, userId);
        promises.push(
          mem.searchTraces(query, limit).then((r) => {
            results['traces'] = r;
          })
        );
      }

      await Promise.all(promises);
      return results;
    }

    // ----- memory_get_context -----
    case 'memory_get_context': {
      const query = requireString(args, 'query');
      const sessionId = optionalString(args, 'session_id');
      const include = optionalStringArray(args, 'include') as
        | ContextInput['include']
        | undefined;
      const limitsRaw = optionalObject(args, 'limits');

      const input: ContextInput = {
        query,
        session_id: sessionId,
        include,
        limits: limitsRaw
          ? {
              messages: typeof limitsRaw['messages'] === 'number' ? limitsRaw['messages'] : undefined,
              entities: typeof limitsRaw['entities'] === 'number' ? limitsRaw['entities'] : undefined,
              preferences: typeof limitsRaw['preferences'] === 'number' ? limitsRaw['preferences'] : undefined,
              facts: typeof limitsRaw['facts'] === 'number' ? limitsRaw['facts'] : undefined,
              traces: typeof limitsRaw['traces'] === 'number' ? limitsRaw['traces'] : undefined,
            }
          : undefined,
      };

      const context = await buildContext(env, projectId, userId, input);
      return { context };
    }

    // ----- memory_add_entity -----
    case 'memory_add_entity': {
      const name = requireString(args, 'name');
      const entityType = requireString(args, 'entity_type') as
        | 'PERSON'
        | 'OBJECT'
        | 'LOCATION'
        | 'EVENT'
        | 'ORGANIZATION'
        | 'CUSTOM';
      const subtype = optionalString(args, 'subtype');
      const description = optionalString(args, 'description');

      const mem = new LongTermMemory(env, projectId, userId);
      const entity = await mem.addEntity({
        name,
        entity_type: entityType,
        subtype,
        description,
      });
      return entity;
    }

    // ----- memory_add_preference -----
    case 'memory_add_preference': {
      const category = requireString(args, 'category');
      const preference = requireString(args, 'preference');
      const context = optionalString(args, 'context');

      const mem = new LongTermMemory(env, projectId, userId);
      const pref = await mem.addPreference({ category, preference, context });
      return pref;
    }

    // ----- memory_add_fact -----
    case 'memory_add_fact': {
      const subject = requireString(args, 'subject');
      const predicate = requireString(args, 'predicate');
      const object = requireString(args, 'object');
      const validFrom = optionalString(args, 'valid_from');
      const validUntil = optionalString(args, 'valid_until');

      const mem = new LongTermMemory(env, projectId, userId);
      const fact = await mem.addFact({
        subject,
        predicate,
        object,
        valid_from: validFrom,
        valid_until: validUntil,
      });
      return fact;
    }

    // ----- memory_start_trace -----
    case 'memory_start_trace': {
      const task = requireString(args, 'task');
      const sessionId = optionalString(args, 'session_id');

      const mem = new ProceduralMemory(env, projectId, userId);
      const trace = await mem.startTrace({ task, session_id: sessionId });
      return trace;
    }

    // ----- memory_promote_to_global -----
    case 'memory_promote_to_global': {
      const type = requireString(args, 'type') as
        | 'entity'
        | 'preference'
        | 'fact';
      const id = requireString(args, 'id');
      const reason = requireString(args, 'reason');

      if (!['entity', 'preference', 'fact'].includes(type)) {
        throw new InvalidParamsError(
          `Invalid type '${type}'. Must be one of: entity, preference, fact`
        );
      }

      const target = (optionalString(args, 'target') ?? 'global') as 'user' | 'global';
      const result = await promote(env, projectId, userId, type, id, reason, target);
      return result;
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC response builders
// ---------------------------------------------------------------------------

function jsonRpcResult(id: string | number, result: unknown): McpResponse {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(
  id: string | number,
  code: number,
  message: string
): McpResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Hono sub-app
// ---------------------------------------------------------------------------

const mcp = new Hono<AppType>();

/**
 * POST /mcp — JSON-RPC endpoint for MCP protocol operations.
 *
 * Handles methods: initialize, tools/list, tools/call
 */
// GET /mcp — required by Streamable HTTP spec, but we don't support server-initiated messages
mcp.get('/', (c) => {
  return c.text('Method Not Allowed', 405);
});

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

  // JSON-RPC notifications have no `id` — acknowledge with 204
  if (!('id' in body)) {
    return c.body(null, 204);
  }

  const id = body['id'] as string | number;
  const request: McpRequest = { jsonrpc: '2.0', id, method, params: body['params'] as Record<string, unknown> | undefined };

  try {
    switch (method) {
      // ---- initialize ----
      case 'initialize': {
        const sessionId = generateId();
        c.header('Mcp-Session-Id', sessionId);
        return c.json(
          jsonRpcResult(id, {
            protocolVersion: '2025-03-26',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'cf-agent-memory',
              version: '0.1.0',
            },
          })
        );
      }

      // ---- tools/list ----
      case 'tools/list': {
        return c.json(jsonRpcResult(id, { tools: TOOL_DEFINITIONS }));
      }

      // ---- tools/call ----
      case 'tools/call': {
        const params = request.params;
        if (!params || typeof params['name'] !== 'string') {
          return c.json(
            jsonRpcError(id, -32602, 'Invalid params: missing tool name'),
            400
          );
        }

        const toolName = params['name'] as string;
        const toolArgs =
          typeof params['arguments'] === 'object' &&
          params['arguments'] !== null &&
          !Array.isArray(params['arguments'])
            ? (params['arguments'] as Record<string, unknown>)
            : {};

        const projectId = c.get('projectId');
        const userId = c.get('userId');

        try {
          const result = await dispatchToolCall(
            c.env,
            projectId,
            userId,
            toolName,
            toolArgs
          );
          return c.json(jsonRpcResult(id, toolResult(result)));
        } catch (err: unknown) {
          if (err instanceof InvalidParamsError) {
            return c.json(jsonRpcError(id, err.code, err.message), 400);
          }
          if (err instanceof Error && err.message.startsWith('Unknown tool:')) {
            return c.json(jsonRpcError(id, -32602, err.message), 400);
          }
          const errMessage =
            err instanceof Error ? err.message : 'Internal error';
          return c.json(jsonRpcError(id, -32603, errMessage), 500);
        }
      }

      default:
        return c.json(jsonRpcError(id, -32601, 'Method not found'), 400);
    }
  } catch (err: unknown) {
    const errMessage =
      err instanceof Error ? err.message : 'Internal server error';
    return c.json(jsonRpcError(id, -32603, errMessage), 500);
  }
});

/**
 * GET /mcp/sse — SSE endpoint for MCP streaming transport.
 *
 * Sends an initial `endpoint` event pointing the client to the POST URL,
 * then keeps the connection alive with periodic pings.
 */
mcp.get('/sse', async (c) => {
  const sessionId = generateId();

  // Determine the POST endpoint URL relative to the request origin.
  const url = new URL(c.req.url);
  const postEndpoint = `${url.protocol}//${url.host}/mcp?sessionId=${sessionId}`;

  return streamSSE(c, async (stream) => {
    // 1. Send the endpoint event so the client knows where to POST.
    await stream.writeSSE({
      event: 'endpoint',
      data: postEndpoint,
    });

    // 2. Keep the connection alive with periodic pings.
    // In a production setup this would also multiplex responses from the POST
    // endpoint back to the client. For this minimal implementation we send
    // keep-alive pings every 30 seconds.
    const PING_INTERVAL_MS = 30_000;
    const MAX_DURATION_MS = 300_000; // 5 minutes max
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_DURATION_MS) {
      await stream.sleep(PING_INTERVAL_MS);
      await stream.writeSSE({
        event: 'ping',
        data: new Date().toISOString(),
      });
    }
  });
});

export default mcp;
