import { Hono } from 'hono';
import type { AppType } from '../types';
import { scopeDoName } from '../durable-objects/memory-events';
import { migrateNamespaces } from '../admin/migrate-namespaces';
import { purgeProject } from '../admin/purge-project';
import { recordAdminAudit } from '../admin/audit';
import { mintConnectToken } from '../auth/connect-token';

const app = new Hono<AppType>();

// Mint a short-lived signed token that binds the current header-resolved
// scope to a WebSocket open. The browser WS API can't send custom headers,
// so callers POST here with X-Project-Id / X-User-Id, then append the
// returned token to the WS URL as `?ws_token=`. The scope middleware
// verifies the signature before honouring the scope.
app.post('/api/v1/events/token', async (c) => {
  const token = await mintConnectToken(c.env, c.get('projectId'), c.get('userId'));
  return c.json(token);
});

// Live events — WebSocket subscribe. Per-scope DO fans out writes.
app.get('/api/v1/events', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, 426);
  }
  if (!c.env.EVENTS) {
    return c.json({ error: 'Events service not configured' }, 503);
  }
  const projectId = c.get('projectId');
  const userId = c.get('userId');
  const id = c.env.EVENTS.idFromName(scopeDoName(projectId, userId));
  const stub = c.env.EVENTS.get(id);
  // Pass the expected scope through an internal header so the DO can log a
  // structured warning if a future routing regression hands it traffic for
  // a different scope (the 2026-04-18 query-param-fallback bug would have
  // surfaced here).
  const inner = new Request(c.req.raw);
  inner.headers.set('X-Internal-Scope', `${projectId}:${userId}`);
  return stub.fetch(inner);
});

// Admin — one-time migrations
app.post('/api/v1/admin/migrate-namespaces', async (c) => {
  const result = await migrateNamespaces(c.env);
  await recordAdminAudit(c, {
    route: '/api/v1/admin/migrate-namespaces',
    method: 'POST',
    target: null,
    status: 200,
    outcome: 'ok',
  });
  return c.json(result);
});

// Admin — hard-purge every row, vector, and cache entry belonging to a
// project. Requires `?confirm=yes` as a typo guard. Pass `?delete_project=true`
// to also drop the `projects` row (default: keep it for reuse).
app.delete('/api/v1/admin/projects/:id/purge', async (c) => {
  const id = c.req.param('id');

  if (c.req.query('confirm') !== 'yes') {
    await recordAdminAudit(c, {
      route: '/api/v1/admin/projects/:id/purge',
      method: 'DELETE',
      target: id,
      status: 400,
      outcome: 'missing-confirmation',
    });
    return c.json(
      {
        error: 'Purge requires explicit confirmation',
        hint: `Append ?confirm=yes to the URL. This deletes every row, vector, and cache entry for project '${id}'.`,
      },
      400
    );
  }

  if (id === 'default' || id === 'global') {
    await recordAdminAudit(c, {
      route: '/api/v1/admin/projects/:id/purge',
      method: 'DELETE',
      target: id,
      status: 400,
      outcome: 'reserved-project',
    });
    return c.json({ error: `Cannot purge reserved project '${id}'` }, 400);
  }

  const deleteProject = c.req.query('delete_project') === 'true';
  const result = await purgeProject(c.env, id, { deleteProject });
  await recordAdminAudit(c, {
    route: '/api/v1/admin/projects/:id/purge',
    method: 'DELETE',
    target: id,
    status: 200,
    outcome: deleteProject ? 'purged-and-removed' : 'purged',
  });
  return c.json(result);
});

export default app;
