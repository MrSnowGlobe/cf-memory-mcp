import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../../src/router';
import { LongTermMemory } from '../../src/memory/long-term';
import { ShortTermMemory } from '../../src/memory/short-term';
import { ProceduralMemory } from '../../src/memory/procedural';
import {
  applyMigrations,
  clearAllTables,
  createTestEnv,
  seedProject,
} from '../helpers/setup';
import type { TestEnv } from '../helpers/setup';

const PROJECT_ID = 'test-mcp-project';
const USER_ID = 'default';

const BASE_HEADERS = {
  'Authorization': 'Bearer test-token',
  'Content-Type': 'application/json',
  'X-Project-Id': PROJECT_ID,
  'X-User-Id': USER_ID,
};

interface JsonRpcOk {
  jsonrpc: '2.0';
  id: string | number;
  result: {
    content: Array<{ type: 'text'; text: string }>;
  };
}

interface JsonRpcErr {
  jsonrpc: '2.0';
  id: string | number;
  error: { code: number; message: string };
}

type JsonRpcResponse = JsonRpcOk | JsonRpcErr;

async function mcpCall(
  testEnv: TestEnv,
  method: string,
  params?: Record<string, unknown>
): Promise<JsonRpcResponse> {
  const res = await app.request(
    '/mcp',
    {
      method: 'POST',
      headers: BASE_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      }),
    },
    testEnv
  );
  const text = await res.text();
  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    throw new Error(`Non-JSON response (status ${res.status}): ${text}`);
  }
}

function extractResult<T>(response: JsonRpcResponse): T {
  if ('error' in response) {
    throw new Error(`MCP error: ${response.error.message}`);
  }
  const text = response.result.content[0]?.text;
  if (!text) throw new Error('No text in result');
  return JSON.parse(text) as T;
}

describe('MCP server', () => {
  let testEnv: TestEnv;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    testEnv = createTestEnv(env.DB, env.CACHE);
    await seedProject(env.DB, PROJECT_ID);
  });

  describe('tools/list', () => {
    it('includes memory_add_relation and memory_traverse', async () => {
      const res = await mcpCall(testEnv, 'tools/list');
      if ('error' in res) throw new Error(res.error.message);
      const tools = (res.result as unknown as { tools: Array<{ name: string }> }).tools;
      const names = tools.map((t) => t.name);
      expect(names).toContain('memory_add_relation');
      expect(names).toContain('memory_traverse');
    });

    it('includes memory_create_session and memory_complete_trace', async () => {
      const res = await mcpCall(testEnv, 'tools/list');
      if ('error' in res) throw new Error(res.error.message);
      const tools = (res.result as unknown as { tools: Array<{ name: string }> }).tools;
      const names = tools.map((t) => t.name);
      expect(names).toContain('memory_create_session');
      expect(names).toContain('memory_complete_trace');
    });
  });

  describe('memory_add_relation', () => {
    it('creates an edge between two existing entities', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, USER_ID);
      const alice = await ltm.addEntity({ name: 'Alice', entity_type: 'PERSON' });
      const bob = await ltm.addEntity({ name: 'Bob', entity_type: 'PERSON' });

      const res = await mcpCall(testEnv, 'tools/call', {
        name: 'memory_add_relation',
        arguments: {
          source_entity_id: alice.id,
          target_entity_id: bob.id,
          relation_type: 'knows',
          relation_strength: 0.7,
        },
      });

      const relation = extractResult<{
        id: string;
        source_entity_id: string;
        target_entity_id: string;
        relation_type: string;
        relation_strength: number;
      }>(res);

      expect(relation.source_entity_id).toBe(alice.id);
      expect(relation.target_entity_id).toBe(bob.id);
      expect(relation.relation_type).toBe('knows');
      expect(relation.relation_strength).toBeCloseTo(0.7);

      const relations = await ltm.getRelations(alice.id);
      expect(relations).toHaveLength(1);
    });

    it('rejects calls missing required args with -32602', async () => {
      const res = await mcpCall(testEnv, 'tools/call', {
        name: 'memory_add_relation',
        arguments: { relation_type: 'knows' },
      });
      if (!('error' in res)) throw new Error('Expected error response');
      expect(res.error.code).toBe(-32602);
    });
  });

  describe('memory_traverse', () => {
    it('walks outward from a root entity and returns neighbours with hop_distance', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, USER_ID);
      const alice = await ltm.addEntity({ name: 'Alice', entity_type: 'PERSON' });
      const bob = await ltm.addEntity({ name: 'Bob', entity_type: 'PERSON' });
      const carol = await ltm.addEntity({ name: 'Carol', entity_type: 'PERSON' });

      await ltm.addRelation(alice.id, bob.id, 'knows');
      await ltm.addRelation(bob.id, carol.id, 'knows');

      const res = await mcpCall(testEnv, 'tools/call', {
        name: 'memory_traverse',
        arguments: {
          entity_id: alice.id,
          max_depth: 2,
          direction: 'out',
        },
      });

      const neighbours = extractResult<Array<{ id: string; name: string; hop_distance: number }>>(
        res
      );

      // Alice should not appear (the traversal excludes the root)
      expect(neighbours.map((n) => n.name).sort()).toEqual(['Bob', 'Carol']);
      const bobHit = neighbours.find((n) => n.name === 'Bob');
      const carolHit = neighbours.find((n) => n.name === 'Carol');
      expect(bobHit?.hop_distance).toBe(1);
      expect(carolHit?.hop_distance).toBe(2);
    });

    it('honours the relation_types filter', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, USER_ID);
      const root = await ltm.addEntity({ name: 'Root', entity_type: 'PERSON' });
      const friend = await ltm.addEntity({ name: 'Friend', entity_type: 'PERSON' });
      const coworker = await ltm.addEntity({ name: 'Coworker', entity_type: 'PERSON' });

      await ltm.addRelation(root.id, friend.id, 'knows');
      await ltm.addRelation(root.id, coworker.id, 'works_with');

      const res = await mcpCall(testEnv, 'tools/call', {
        name: 'memory_traverse',
        arguments: {
          entity_id: root.id,
          relation_types: ['knows'],
          direction: 'out',
        },
      });

      const neighbours = extractResult<Array<{ name: string }>>(res);
      expect(neighbours.map((n) => n.name)).toEqual(['Friend']);
    });
  });

  describe('memory_create_session', () => {
    it('creates a session with an explicit id and lets memory_add_message write to it', async () => {
      const res = await mcpCall(testEnv, 'tools/call', {
        name: 'memory_create_session',
        arguments: { id: 'my-session', metadata: { purpose: 'test' } },
      });
      const session = extractResult<{ id: string; project_id: string }>(res);
      expect(session.id).toBe('my-session');
      expect(session.project_id).toBe(PROJECT_ID);

      const addRes = await mcpCall(testEnv, 'tools/call', {
        name: 'memory_add_message',
        arguments: { session_id: 'my-session', role: 'user', content: 'hello' },
      });
      const msg = extractResult<{ session_id: string; role: string }>(addRes);
      expect(msg.session_id).toBe('my-session');
      expect(msg.role).toBe('user');
    });

    it('generates an id when none is provided', async () => {
      const res = await mcpCall(testEnv, 'tools/call', {
        name: 'memory_create_session',
        arguments: {},
      });
      const session = extractResult<{ id: string }>(res);
      expect(session.id).toMatch(/^[0-9a-f]{32}$/);

      const stm = new ShortTermMemory(testEnv, PROJECT_ID, USER_ID);
      const fetched = await stm.getSession(session.id);
      expect(fetched?.id).toBe(session.id);
    });
  });

  describe('memory_complete_trace', () => {
    it('completes an open trace with outcome, success, and duration_ms', async () => {
      const pm = new ProceduralMemory(testEnv, PROJECT_ID, USER_ID);
      const trace = await pm.startTrace({ task: 'ship the thing' });

      const res = await mcpCall(testEnv, 'tools/call', {
        name: 'memory_complete_trace',
        arguments: { id: trace.id, outcome: 'shipped', success: true },
      });
      const completed = extractResult<{
        id: string;
        success: number;
        outcome: string;
        duration_ms: number | null;
      }>(res);

      expect(completed.id).toBe(trace.id);
      expect(completed.outcome).toBe('shipped');
      expect(completed.success).toBe(1);
      expect(completed.duration_ms).not.toBeNull();
    });

    it('returns a JSON-RPC error when the trace id does not exist', async () => {
      const res = await mcpCall(testEnv, 'tools/call', {
        name: 'memory_complete_trace',
        arguments: { id: 'does-not-exist', outcome: 'n/a', success: false },
      });
      expect('error' in res).toBe(true);
    });
  });
});
