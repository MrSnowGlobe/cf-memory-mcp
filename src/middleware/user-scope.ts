import { createMiddleware } from 'hono/factory';
import type { AppType } from '../types';

export const userScopeMiddleware = createMiddleware<AppType>(async (c, next) => {
  const userId = c.req.header('X-User-Id') || 'default';

  // Auto-create user if it doesn't exist
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, display_name) VALUES (?, ?)`
  )
    .bind(userId, userId)
    .run();

  c.set('userId', userId);
  await next();
});
