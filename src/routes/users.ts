import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppType } from '../types';
import { CreateUserSchema } from '../utils/validation';

const app = new Hono<AppType>();

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

// Single-user lookup — users are global (no project_id column), so this
// route is intentionally not project-scoped. Mirrors POST semantics so a
// caller doing read-after-write doesn't see ghost-not-found.
app.get('/api/v1/users/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT id, display_name, created_at, metadata FROM users WHERE id = ?'
  )
    .bind(id)
    .first();
  if (!row) {
    return c.json({ error: `User '${id}' not found` }, 404);
  }
  return c.json(row);
});

export default app;
