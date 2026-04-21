import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppType } from '../types';
import {
  CreateSessionSchema,
  AddMessageSchema,
  BatchMessagesSchema,
  SearchQuerySchema,
} from '../utils/validation';
import { stm } from './_shared';

const app = new Hono<AppType>();

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

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

export default app;
