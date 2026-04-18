import { createMiddleware } from 'hono/factory';
import type { AppType } from '../types';

const knownProjects = new Set<string>();

export const projectScopeMiddleware = createMiddleware<AppType>(async (c, next) => {
  // Header wins; query param is a fallback for contexts where headers
  // aren't available (e.g. browser WebSocket opens can't set headers).
  const projectId =
    c.req.header('X-Project-Id') || c.req.query('project_id') || 'default';

  if (!knownProjects.has(projectId)) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO projects (id, display_name) VALUES (?, ?)`
    )
      .bind(projectId, projectId)
      .run();
    knownProjects.add(projectId);
  }

  c.set('projectId', projectId);
  await next();
});
