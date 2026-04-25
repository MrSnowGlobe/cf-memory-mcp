import { createMiddleware } from 'hono/factory';
import type { AppType } from '../types';

// Reserved IDs that are always valid without explicit registration.
// 'default' is the fallback scope for clients that send no header;
// 'global' is the cascading-read namespace used by promotion.
const RESERVED_PROJECTS = new Set(['default', 'global']);

// In-memory cache of project IDs confirmed to exist in D1. Populated
// lazily — a miss falls through to a SELECT before rejecting, so new
// registrations are picked up without a Worker restart.
const knownProjects = new Set<string>();

export const projectScopeMiddleware = createMiddleware<AppType>(async (c, next) => {
  // Header wins; query param is a fallback for contexts where headers
  // aren't available (e.g. browser WebSocket opens can't set headers).
  const projectId =
    c.req.header('X-Project-Id') || c.req.query('project_id') || 'default';

  // Project-management endpoints must bypass the registration gate
  // (otherwise you can't register the first project) and the cross-
  // scope atlas is deliberately project-agnostic.
  const path = new URL(c.req.url).pathname;
  const skipGate =
    path === '/api/v1/projects' ||
    path.startsWith('/api/v1/projects/') ||
    path === '/api/v1/atlas';

  if (!skipGate && !RESERVED_PROJECTS.has(projectId) && !knownProjects.has(projectId)) {
    // Auto-provision on first sight, mirroring user-scope middleware. The
    // CLAUDE.md design contract specifies this; the previous gate-and-404
    // behaviour was a divergence that broke fresh deploys and the MCP
    // path (which has no way to call POST /api/v1/projects ahead of
    // time). INSERT OR IGNORE so concurrent first-writes are idempotent.
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

/**
 * Invalidate the in-memory known-projects cache for an ID. Call this
 * when a project is deleted so a later request with the same ID falls
 * back to the DB check (and gets rejected) instead of being accepted
 * by a stale cache entry.
 */
export function forgetProject(projectId: string): void {
  knownProjects.delete(projectId);
}

/**
 * Prime the cache when a project is registered via POST /projects, so
 * the next request from the same isolate doesn't need a SELECT.
 */
export function rememberProject(projectId: string): void {
  knownProjects.add(projectId);
}
