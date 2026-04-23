import { Hono } from 'hono';
import type { AppType } from '../types';
import { scopeDoName } from '../durable-objects/memory-events';
import { migrateNamespaces } from '../admin/migrate-namespaces';
import { purgeProject } from '../admin/purge-project';

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

// Admin — hard-purge every row, vector, and cache entry belonging to a
// project. Requires `?confirm=yes` as a typo guard. Pass `?delete_project=true`
// to also drop the `projects` row (default: keep it for reuse).
app.delete('/api/v1/admin/projects/:id/purge', async (c) => {
  const id = c.req.param('id');

  if (c.req.query('confirm') !== 'yes') {
    return c.json(
      {
        error: 'Purge requires explicit confirmation',
        hint: `Append ?confirm=yes to the URL. This deletes every row, vector, and cache entry for project '${id}'.`,
      },
      400
    );
  }

  if (id === 'default' || id === 'global') {
    return c.json({ error: `Cannot purge reserved project '${id}'` }, 400);
  }

  const deleteProject = c.req.query('delete_project') === 'true';
  const result = await purgeProject(c.env, id, { deleteProject });
  return c.json(result);
});

export default app;
