import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppType } from './types';
import { authMiddleware } from './middleware/auth';
import { projectScopeMiddleware } from './middleware/project-scope';
import { userScopeMiddleware } from './middleware/user-scope';
import { generateId } from './utils/ids';
import {
  CreateSessionSchema,
  AddMessageSchema,
  BatchMessagesSchema,
  SearchQuerySchema,
  AddEntitySchema,
  UpdateEntitySchema,
  AddRelationSchema,
  AddPreferenceSchema,
  AddFactSchema,
  InvalidateFactSchema,
  StartTraceSchema,
  CompleteTraceSchema,
  AddStepSchema,
  RecordToolCallSchema,
  PromoteRequestSchema,
  ContextRequestSchema,
  CreateProjectSchema,
  CreateUserSchema,
} from './utils/validation';
import { ShortTermMemory } from './memory/short-term';
import { LongTermMemory } from './memory/long-term';
import { ProceduralMemory } from './memory/procedural';
import { buildContext } from './memory/context';
import { promoteToGlobal, promote } from './memory/promotion';
import { migrateNamespaces } from './admin/migrate-namespaces';
import mcpServer from './mcp/server';

const app = new Hono<AppType>();

// ---------------------------------------------------------------------------
// Security headers on all responses
// ---------------------------------------------------------------------------

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Cache-Control', 'no-store');
});

// ---------------------------------------------------------------------------
// Health check (no auth required)
// ---------------------------------------------------------------------------

app.get('/health', (c) => c.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// Apply middleware to all API and MCP routes
// ---------------------------------------------------------------------------

app.use('/api/*', authMiddleware);
app.use('/api/*', projectScopeMiddleware);
app.use('/api/*', userScopeMiddleware);
app.use('/mcp/*', authMiddleware);
app.use('/mcp/*', projectScopeMiddleware);
app.use('/mcp/*', userScopeMiddleware);

// ===========================================================================
// Projects
// ===========================================================================

app.post(
  '/api/v1/projects',
  zValidator('json', CreateProjectSchema),
  async (c) => {
    try {
      const body = c.req.valid('json');
      const now = new Date().toISOString();
      const metaJson = JSON.stringify(body.metadata ?? {});

      await c.env.DB.prepare(
        'INSERT INTO projects (id, display_name, created_at, metadata) VALUES (?, ?, ?, ?)'
      )
        .bind(body.id, body.display_name ?? null, now, metaJson)
        .run();

      return c.json(
        {
          id: body.id,
          display_name: body.display_name ?? null,
          created_at: now,
          metadata: metaJson,
        },
        201
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('UNIQUE constraint')) {
        return c.json({ error: 'Project already exists' }, 409);
      }
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

app.get('/api/v1/projects', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      'SELECT * FROM projects ORDER BY created_at DESC'
    )
      .all();
    return c.json(result.results);
  } catch {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ===========================================================================
// Users
// ===========================================================================

// POST /api/v1/users - Create user
app.post(
  '/api/v1/users',
  zValidator('json', CreateUserSchema),
  async (c) => {
    try {
      const body = c.req.valid('json');
      const now = new Date().toISOString();
      const metaJson = JSON.stringify(body.metadata ?? {});
      await c.env.DB.prepare(
        'INSERT INTO users (id, display_name, created_at, metadata) VALUES (?, ?, ?, ?)'
      )
        .bind(body.id, body.display_name ?? null, now, metaJson)
        .run();
      return c.json({ id: body.id, display_name: body.display_name ?? null, created_at: now, metadata: body.metadata ?? {} }, 201);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (msg.includes('UNIQUE constraint')) {
        return c.json({ error: `User '${(c.req.valid('json') as { id: string }).id}' already exists` }, 409);
      }
      return c.json({ error: msg }, 500);
    }
  }
);

// GET /api/v1/users - List users
app.get('/api/v1/users', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      'SELECT * FROM users ORDER BY created_at DESC'
    ).all();
    return c.json(result.results);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

// ===========================================================================
// Short-Term Memory — Sessions
// ===========================================================================

app.post(
  '/api/v1/sessions',
  zValidator('json', CreateSessionSchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const body = c.req.valid('json');
      const mem = new ShortTermMemory(c.env, projectId, userId);
      const session = await mem.createSession(body.id, body.metadata);
      return c.json(session, 201);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

app.get('/api/v1/sessions', async (c) => {
  try {
    const projectId = c.get('projectId');
    const userId = c.get('userId');
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    const offset = c.req.query('offset') ? Number(c.req.query('offset')) : undefined;
    const mem = new ShortTermMemory(c.env, projectId, userId);
    const sessions = await mem.listSessions({ limit, offset });
    return c.json(sessions);
  } catch {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.get('/api/v1/sessions/:id', async (c) => {
  try {
    const projectId = c.get('projectId');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const mem = new ShortTermMemory(c.env, projectId, userId);
    const session = await mem.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    return c.json(session);
  } catch {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.delete('/api/v1/sessions/:id', async (c) => {
  try {
    const projectId = c.get('projectId');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const mem = new ShortTermMemory(c.env, projectId, userId);
    await mem.deleteSession(id);
    return c.body(null, 204);
  } catch {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ===========================================================================
// Short-Term Memory — Messages
// ===========================================================================

app.post(
  '/api/v1/sessions/:id/messages',
  zValidator('json', AddMessageSchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const sessionId = c.req.param('id');
      const body = c.req.valid('json');
      const mem = new ShortTermMemory(c.env, projectId, userId);
      const message = await mem.addMessage(
        sessionId,
        body.role,
        body.content,
        body.metadata
      );
      return c.json(message, 201);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

app.get('/api/v1/sessions/:id/messages', async (c) => {
  try {
    const projectId = c.get('projectId');
    const userId = c.get('userId');
    const sessionId = c.req.param('id');
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    const mem = new ShortTermMemory(c.env, projectId, userId);
    const messages = await mem.getConversation(sessionId, limit);
    return c.json(messages);
  } catch {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.post(
  '/api/v1/sessions/:id/messages/batch',
  zValidator('json', BatchMessagesSchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const sessionId = c.req.param('id');
      const body = c.req.valid('json');
      const mem = new ShortTermMemory(c.env, projectId, userId);
      const count = await mem.addMessagesBatch(sessionId, body.messages);
      return c.json({ count }, 201);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

app.post(
  '/api/v1/messages/search',
  zValidator('json', SearchQuerySchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const body = c.req.valid('json');
      const mem = new ShortTermMemory(c.env, projectId, userId);
      const results = await mem.searchMessages(body.query, {
        sessionId: body.session_id,
        limit: body.limit,
      });
      return c.json(results);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

// ===========================================================================
// Long-Term Memory — Entities
// ===========================================================================

app.post(
  '/api/v1/entities',
  zValidator('json', AddEntitySchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const body = c.req.valid('json');
      const mem = new LongTermMemory(c.env, projectId, userId);
      const entity = await mem.addEntity(body);
      return c.json(entity, 201);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

app.get('/api/v1/entities/:id', async (c) => {
  try {
    const projectId = c.get('projectId');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const mem = new LongTermMemory(c.env, projectId, userId);
    const entity = await mem.getEntity(id);
    if (!entity) {
      return c.json({ error: 'Entity not found' }, 404);
    }
    return c.json(entity);
  } catch {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.put(
  '/api/v1/entities/:id',
  zValidator('json', UpdateEntitySchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const id = c.req.param('id');
      const body = c.req.valid('json');
      const mem = new LongTermMemory(c.env, projectId, userId);
      const entity = await mem.updateEntity(id, body);
      return c.json(entity);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('not found')) {
        return c.json({ error: 'Resource not found' }, 404);
      }
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

app.delete('/api/v1/entities/:id', async (c) => {
  try {
    const projectId = c.get('projectId');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const mem = new LongTermMemory(c.env, projectId, userId);
    await mem.deleteEntity(id);
    return c.body(null, 204);
  } catch {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.post(
  '/api/v1/entities/search',
  zValidator('json', SearchQuerySchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const body = c.req.valid('json');
      const mem = new LongTermMemory(c.env, projectId, userId);
      const results = await mem.searchEntities(body.query, body.limit);
      return c.json(results);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

app.post(
  '/api/v1/entities/:id/relations',
  zValidator('json', AddRelationSchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const sourceId = c.req.param('id');
      const body = c.req.valid('json');
      const mem = new LongTermMemory(c.env, projectId, userId);
      const relation = await mem.addRelation(
        sourceId,
        body.target_entity_id,
        body.relation_type,
        body.metadata
      );
      return c.json(relation, 201);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

app.get('/api/v1/entities/:id/relations', async (c) => {
  try {
    const projectId = c.get('projectId');
    const userId = c.get('userId');
    const entityId = c.req.param('id');
    const mem = new LongTermMemory(c.env, projectId, userId);
    const relations = await mem.getRelations(entityId);
    return c.json(relations);
  } catch {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ===========================================================================
// Long-Term Memory — Preferences
// ===========================================================================

app.post(
  '/api/v1/preferences',
  zValidator('json', AddPreferenceSchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const body = c.req.valid('json');
      const mem = new LongTermMemory(c.env, projectId, userId);
      const preference = await mem.addPreference(body);
      return c.json(preference, 201);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

app.get('/api/v1/preferences', async (c) => {
  try {
    const projectId = c.get('projectId');
    const userId = c.get('userId');
    const category = c.req.query('category');
    const mem = new LongTermMemory(c.env, projectId, userId);
    const preferences = await mem.listPreferences(category);
    return c.json(preferences);
  } catch {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.post(
  '/api/v1/preferences/search',
  zValidator('json', SearchQuerySchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const body = c.req.valid('json');
      const mem = new LongTermMemory(c.env, projectId, userId);
      const results = await mem.searchPreferences(body.query, body.limit);
      return c.json(results);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

// ===========================================================================
// Long-Term Memory — Facts
// ===========================================================================

app.post(
  '/api/v1/facts',
  zValidator('json', AddFactSchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const body = c.req.valid('json');
      const mem = new LongTermMemory(c.env, projectId, userId);
      const fact = await mem.addFact(body);
      return c.json(fact, 201);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

app.get('/api/v1/facts', async (c) => {
  try {
    const projectId = c.get('projectId');
    const userId = c.get('userId');
    const subject = c.req.query('subject');
    const predicate = c.req.query('predicate');
    const mem = new LongTermMemory(c.env, projectId, userId);
    const facts = await mem.listFacts({ subject, predicate });
    return c.json(facts);
  } catch {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.post(
  '/api/v1/facts/search',
  zValidator('json', SearchQuerySchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const body = c.req.valid('json');
      const mem = new LongTermMemory(c.env, projectId, userId);
      const results = await mem.searchFacts(body.query, body.limit);
      return c.json(results);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

app.put(
  '/api/v1/facts/:id/invalidate',
  zValidator('json', InvalidateFactSchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const id = c.req.param('id');
      const body = c.req.valid('json');
      const mem = new LongTermMemory(c.env, projectId, userId);
      await mem.invalidateFact(id, body.valid_until);
      return c.json({ success: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('not found')) {
        return c.json({ error: 'Resource not found' }, 404);
      }
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

// ===========================================================================
// Procedural Memory — Traces
// ===========================================================================

app.post(
  '/api/v1/traces',
  zValidator('json', StartTraceSchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const body = c.req.valid('json');
      const mem = new ProceduralMemory(c.env, projectId, userId);
      const trace = await mem.startTrace(body);
      return c.json(trace, 201);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

app.put(
  '/api/v1/traces/:id/complete',
  zValidator('json', CompleteTraceSchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const id = c.req.param('id');
      const body = c.req.valid('json');
      const mem = new ProceduralMemory(c.env, projectId, userId);
      const trace = await mem.completeTrace(id, body.outcome, body.success);
      return c.json(trace);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('not found')) {
        return c.json({ error: 'Resource not found' }, 404);
      }
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

app.get('/api/v1/traces', async (c) => {
  try {
    const projectId = c.get('projectId');
    const userId = c.get('userId');
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    const offset = c.req.query('offset') ? Number(c.req.query('offset')) : undefined;
    const sessionId = c.req.query('session_id');
    const successParam = c.req.query('success');
    const success =
      successParam === 'true' ? true : successParam === 'false' ? false : undefined;

    const mem = new ProceduralMemory(c.env, projectId, userId);
    const traces = await mem.listTraces({
      limit,
      offset,
      session_id: sessionId,
      success,
    });
    return c.json(traces);
  } catch {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.post(
  '/api/v1/traces/search',
  zValidator('json', SearchQuerySchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const body = c.req.valid('json');
      const mem = new ProceduralMemory(c.env, projectId, userId);
      const results = await mem.searchTraces(body.query, body.limit);
      return c.json(results);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

// ===========================================================================
// Procedural Memory — Steps & Tool Calls
// ===========================================================================

app.post(
  '/api/v1/traces/:id/steps',
  zValidator('json', AddStepSchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const traceId = c.req.param('id');
      const body = c.req.valid('json');
      const mem = new ProceduralMemory(c.env, projectId, userId);
      const step = await mem.addStep(traceId, body);
      return c.json(step, 201);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('not found')) {
        return c.json({ error: 'Resource not found' }, 404);
      }
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

app.post(
  '/api/v1/steps/:id/tool-calls',
  zValidator('json', RecordToolCallSchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const stepId = c.req.param('id');
      const body = c.req.valid('json');
      const mem = new ProceduralMemory(c.env, projectId, userId);
      const toolCall = await mem.recordToolCall(stepId, body);
      return c.json(toolCall, 201);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

app.get('/api/v1/tool-stats', async (c) => {
  try {
    const projectId = c.get('projectId');
    const userId = c.get('userId');
    const mem = new ProceduralMemory(c.env, projectId, userId);
    const stats = await mem.getToolStats();
    return c.json(stats);
  } catch {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ===========================================================================
// Promotion & Context
// ===========================================================================

app.post(
  '/api/v1/promote',
  zValidator('json', PromoteRequestSchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const body = c.req.valid('json');
      const result = await promote(
        c.env,
        projectId,
        userId,
        body.type,
        body.id,
        body.reason,
        body.target ?? 'global'
      );
      return c.json(result, 201);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('not found')) {
        return c.json({ error: 'Resource not found' }, 404);
      }
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

app.post(
  '/api/v1/context',
  zValidator('json', ContextRequestSchema),
  async (c) => {
    try {
      const projectId = c.get('projectId');
      const userId = c.get('userId');
      const body = c.req.valid('json');
      const context = await buildContext(c.env, projectId, userId, body);
      return c.json({ context });
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  }
);

// ===========================================================================
// Admin — One-time migrations
// ===========================================================================

app.post('/api/v1/admin/migrate-namespaces', async (c) => {
  try {
    const result = await migrateNamespaces(c.env);
    return c.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Migration failed';
    return c.json({ error: message }, 500);
  }
});

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

app.route('/mcp', mcpServer);

// ---------------------------------------------------------------------------
// Catch-all: return JSON 404 for any unmatched routes.
// Without this, Cloudflare returns HTML "404 Not Found" which breaks
// MCP clients that probe OAuth discovery endpoints (.well-known/*).
// ---------------------------------------------------------------------------

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;
