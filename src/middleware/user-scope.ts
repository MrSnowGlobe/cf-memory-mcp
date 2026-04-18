import { createMiddleware } from 'hono/factory';
import type { AppType } from '../types';

const knownUsers = new Set<string>();

export const userScopeMiddleware = createMiddleware<AppType>(async (c, next) => {
  const userId = c.req.header('X-User-Id') || 'default';

  if (!knownUsers.has(userId)) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, display_name) VALUES (?, ?)`
    )
      .bind(userId, userId)
      .run();
    knownUsers.add(userId);
  }

  c.set('userId', userId);
  await next();
});
