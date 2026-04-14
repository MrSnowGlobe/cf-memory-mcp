import { createMiddleware } from 'hono/factory';
import type { AppType } from '../types';

export const projectScopeMiddleware = createMiddleware<AppType>(async (c, next) => {
  const projectId = c.req.header('X-Project-Id') || 'default';

  // Auto-create project if it doesn't exist
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO projects (id, display_name) VALUES (?, ?)`
  )
    .bind(projectId, projectId)
    .run();

  c.set('projectId', projectId);
  await next();
});
