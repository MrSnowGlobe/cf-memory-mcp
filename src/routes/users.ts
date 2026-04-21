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

export default app;
