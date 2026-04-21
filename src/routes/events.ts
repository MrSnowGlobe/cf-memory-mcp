import { Hono } from 'hono';
import type { AppType } from '../types';
import { scopeDoName } from '../durable-objects/memory-events';
import { migrateNamespaces } from '../admin/migrate-namespaces';
import { reembedAllVectors } from '../admin/reembed-vectors';

const app = new Hono<AppType>();

// Live events — WebSocket subscribe. Per-scope DO fans out writes.
app.get('/api/v1/events', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, 426);
  }
  if (!c.env.EVENTS) {
    return c.json({ error: 'Events service not configured' }, 503);
  }
  const id = c.env.EVENTS.idFromName(
    scopeDoName(c.get('projectId'), c.get('userId'))
  );
  const stub = c.env.EVENTS.get(id);
  return stub.fetch(c.req.raw);
});

// Admin — one-time migrations
app.post('/api/v1/admin/migrate-namespaces', async (c) => {
  const result = await migrateNamespaces(c.env);
  return c.json(result);
});

// Re-embed every vector with the current EMBEDDING.model config. Use after
// swapping the embedding model so old/new vectors share a semantic space.
app.post('/api/v1/admin/reembed-vectors', async (c) => {
  const result = await reembedAllVectors(c.env);
  return c.json(result);
});

export default app;
