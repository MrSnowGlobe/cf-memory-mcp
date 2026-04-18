import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { zValidator } from '@hono/zod-validator';
import type { AppType } from './types';
import { HttpError } from './utils/errors';
import { authMiddleware } from './middleware/auth';
import { projectScopeMiddleware } from './middleware/project-scope';
import { userScopeMiddleware } from './middleware/user-scope';
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
import { promote } from './memory/promotion';
import { migrateNamespaces } from './admin/migrate-namespaces';
import mcpServer from './mcp/server';

const app = new Hono<AppType>();

// ---------------------------------------------------------------------------
// Global error handler — maps typed errors to HTTP status codes.
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as ContentfulStatusCode);
  }
  const message = err instanceof Error ? err.message : '';
  if (message.includes('UNIQUE constraint')) {
    return c.json({ error: 'Resource already exists' }, 409);
  }
  console.error('[router] unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

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

// ---------------------------------------------------------------------------
// Memory class factories
// ---------------------------------------------------------------------------

type Ctx = Context<AppType>;
const stm = (c: Ctx) => new ShortTermMemory(c.env, c.get('projectId'), c.get('userId'));
const ltm = (c: Ctx) => new LongTermMemory(c.env, c.get('projectId'), c.get('userId'));
const pm = (c: Ctx) => new ProceduralMemory(c.env, c.get('projectId'), c.get('userId'));

// ===========================================================================
// Projects
// ===========================================================================

app.post(
  '/api/v1/projects',
  zValidator('json', CreateProjectSchema),
  async (c) => {
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
  }
);

app.get('/api/v1/projects', async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT * FROM projects ORDER BY created_at DESC'
  ).all();
  return c.json(result.results);
});

// ===========================================================================
// Users
// ===========================================================================

app.post(
  '/api/v1/users',
  zValidator('json', CreateUserSchema),
  async (c) => {
    const body = c.req.valid('json');
    const now = new Date().toISOString();
    const metaJson = JSON.stringify(body.metadata ?? {});
    await c.env.DB.prepare(
      'INSERT INTO users (id, display_name, created_at, metadata) VALUES (?, ?, ?, ?)'
    )
      .bind(body.id, body.display_name ?? null, now, metaJson)
      .run();
    return c.json(
      {
        id: body.id,
        display_name: body.display_name ?? null,
        created_at: now,
        metadata: body.metadata ?? {},
      },
      201
    );
  }
);

app.get('/api/v1/users', async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT * FROM users ORDER BY created_at DESC'
  ).all();
  return c.json(result.results);
});

// ===========================================================================
// Short-Term Memory — Sessions
// ===========================================================================

app.post(
  '/api/v1/sessions',
  zValidator('json', CreateSessionSchema),
  async (c) => {
    const body = c.req.valid('json');
    const session = await stm(c).createSession(body.id, body.metadata);
    return c.json(session, 201);
  }
);

app.get('/api/v1/sessions', async (c) => {
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
  const offset = c.req.query('offset') ? Number(c.req.query('offset')) : undefined;
  const sessions = await stm(c).listSessions({ limit, offset });
  return c.json(sessions);
});

app.get('/api/v1/sessions/:id', async (c) => {
  const session = await stm(c).getSession(c.req.param('id'));
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }
  return c.json(session);
});

app.delete('/api/v1/sessions/:id', async (c) => {
  await stm(c).deleteSession(c.req.param('id'));
  return c.body(null, 204);
});

// ===========================================================================
// Short-Term Memory — Messages
// ===========================================================================

app.post(
  '/api/v1/sessions/:id/messages',
  zValidator('json', AddMessageSchema),
  async (c) => {
    const body = c.req.valid('json');
    const message = await stm(c).addMessage(
      c.req.param('id'),
      body.role,
      body.content,
      body.metadata
    );
    return c.json(message, 201);
  }
);

app.get('/api/v1/sessions/:id/messages', async (c) => {
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
  const messages = await stm(c).getConversation(c.req.param('id'), limit);
  return c.json(messages);
});

app.post(
  '/api/v1/sessions/:id/messages/batch',
  zValidator('json', BatchMessagesSchema),
  async (c) => {
    const body = c.req.valid('json');
    const count = await stm(c).addMessagesBatch(c.req.param('id'), body.messages);
    return c.json({ count }, 201);
  }
);

app.post(
  '/api/v1/messages/search',
  zValidator('json', SearchQuerySchema),
  async (c) => {
    const body = c.req.valid('json');
    const results = await stm(c).searchMessages(body.query, {
      sessionId: body.session_id,
      limit: body.limit,
    });
    return c.json(results);
  }
);

// ===========================================================================
// Long-Term Memory — Entities
// ===========================================================================

app.post(
  '/api/v1/entities',
  zValidator('json', AddEntitySchema),
  async (c) => {
    const body = c.req.valid('json');
    const entity = await ltm(c).addEntity(body);
    return c.json(entity, 201);
  }
);

app.get('/api/v1/entities/:id', async (c) => {
  const entity = await ltm(c).getEntity(c.req.param('id'));
  if (!entity) {
    return c.json({ error: 'Entity not found' }, 404);
  }
  return c.json(entity);
});

app.put(
  '/api/v1/entities/:id',
  zValidator('json', UpdateEntitySchema),
  async (c) => {
    const body = c.req.valid('json');
    const entity = await ltm(c).updateEntity(c.req.param('id'), body);
    return c.json(entity);
  }
);

app.delete('/api/v1/entities/:id', async (c) => {
  await ltm(c).deleteEntity(c.req.param('id'));
  return c.body(null, 204);
});

app.post(
  '/api/v1/entities/search',
  zValidator('json', SearchQuerySchema),
  async (c) => {
    const body = c.req.valid('json');
    const results = await ltm(c).searchEntities(body.query, body.limit);
    return c.json(results);
  }
);

app.post(
  '/api/v1/entities/:id/relations',
  zValidator('json', AddRelationSchema),
  async (c) => {
    const body = c.req.valid('json');
    const relation = await ltm(c).addRelation(
      c.req.param('id'),
      body.target_entity_id,
      body.relation_type,
      body.metadata
    );
    return c.json(relation, 201);
  }
);

app.get('/api/v1/entities/:id/relations', async (c) => {
  const relations = await ltm(c).getRelations(c.req.param('id'));
  return c.json(relations);
});

// ===========================================================================
// Long-Term Memory — Preferences
// ===========================================================================

app.post(
  '/api/v1/preferences',
  zValidator('json', AddPreferenceSchema),
  async (c) => {
    const body = c.req.valid('json');
    const preference = await ltm(c).addPreference(body);
    return c.json(preference, 201);
  }
);

app.get('/api/v1/preferences', async (c) => {
  const category = c.req.query('category');
  const preferences = await ltm(c).listPreferences(category);
  return c.json(preferences);
});

app.post(
  '/api/v1/preferences/search',
  zValidator('json', SearchQuerySchema),
  async (c) => {
    const body = c.req.valid('json');
    const results = await ltm(c).searchPreferences(body.query, body.limit);
    return c.json(results);
  }
);

// ===========================================================================
// Long-Term Memory — Facts
// ===========================================================================

app.post(
  '/api/v1/facts',
  zValidator('json', AddFactSchema),
  async (c) => {
    const body = c.req.valid('json');
    const fact = await ltm(c).addFact(body);
    return c.json(fact, 201);
  }
);

app.get('/api/v1/facts', async (c) => {
  const subject = c.req.query('subject');
  const predicate = c.req.query('predicate');
  const facts = await ltm(c).listFacts({ subject, predicate });
  return c.json(facts);
});

app.post(
  '/api/v1/facts/search',
  zValidator('json', SearchQuerySchema),
  async (c) => {
    const body = c.req.valid('json');
    const results = await ltm(c).searchFacts(body.query, body.limit);
    return c.json(results);
  }
);

app.put(
  '/api/v1/facts/:id/invalidate',
  zValidator('json', InvalidateFactSchema),
  async (c) => {
    const body = c.req.valid('json');
    await ltm(c).invalidateFact(c.req.param('id'), body.valid_until);
    return c.json({ success: true });
  }
);

// ===========================================================================
// Procedural Memory — Traces
// ===========================================================================

app.post(
  '/api/v1/traces',
  zValidator('json', StartTraceSchema),
  async (c) => {
    const body = c.req.valid('json');
    const trace = await pm(c).startTrace(body);
    return c.json(trace, 201);
  }
);

app.put(
  '/api/v1/traces/:id/complete',
  zValidator('json', CompleteTraceSchema),
  async (c) => {
    const body = c.req.valid('json');
    const trace = await pm(c).completeTrace(c.req.param('id'), body.outcome, body.success);
    return c.json(trace);
  }
);

app.get('/api/v1/traces', async (c) => {
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
  const offset = c.req.query('offset') ? Number(c.req.query('offset')) : undefined;
  const sessionId = c.req.query('session_id');
  const successParam = c.req.query('success');
  const success =
    successParam === 'true' ? true : successParam === 'false' ? false : undefined;

  const traces = await pm(c).listTraces({ limit, offset, session_id: sessionId, success });
  return c.json(traces);
});

app.post(
  '/api/v1/traces/search',
  zValidator('json', SearchQuerySchema),
  async (c) => {
    const body = c.req.valid('json');
    const results = await pm(c).searchTraces(body.query, body.limit);
    return c.json(results);
  }
);

// ===========================================================================
// Procedural Memory — Steps & Tool Calls
// ===========================================================================

app.post(
  '/api/v1/traces/:id/steps',
  zValidator('json', AddStepSchema),
  async (c) => {
    const body = c.req.valid('json');
    const step = await pm(c).addStep(c.req.param('id'), body);
    return c.json(step, 201);
  }
);

app.post(
  '/api/v1/steps/:id/tool-calls',
  zValidator('json', RecordToolCallSchema),
  async (c) => {
    const body = c.req.valid('json');
    const toolCall = await pm(c).recordToolCall(c.req.param('id'), body);
    return c.json(toolCall, 201);
  }
);

app.get('/api/v1/tool-stats', async (c) => {
  const stats = await pm(c).getToolStats();
  return c.json(stats);
});

// ===========================================================================
// Promotion & Context
// ===========================================================================

app.post(
  '/api/v1/promote',
  zValidator('json', PromoteRequestSchema),
  async (c) => {
    const body = c.req.valid('json');
    const result = await promote(
      c.env,
      c.get('projectId'),
      c.get('userId'),
      body.type,
      body.id,
      body.reason,
      body.target ?? 'global'
    );
    return c.json(result, 201);
  }
);

app.post(
  '/api/v1/context',
  zValidator('json', ContextRequestSchema),
  async (c) => {
    const body = c.req.valid('json');
    const context = await buildContext(c.env, c.get('projectId'), c.get('userId'), body);
    return c.json({ context });
  }
);

// ===========================================================================
// Admin — One-time migrations
// ===========================================================================

app.post('/api/v1/admin/migrate-namespaces', async (c) => {
  const result = await migrateNamespaces(c.env);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

app.route('/mcp', mcpServer);

// ---------------------------------------------------------------------------
// Catch-all: return JSON 404 for any unmatched routes.
// ---------------------------------------------------------------------------

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;
