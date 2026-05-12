import { createMiddleware } from 'hono/factory';
import type { AppType } from '../types';
import { isValidScopeId } from '../utils/ids';
import { verifyConnectToken } from '../auth/connect-token';

// Reserved IDs that are always valid without explicit registration.
// 'default' is the fallback scope for clients that send no header;
// 'global' is the cascading-read namespace used by promotion.
const RESERVED_PROJECTS = new Set(['default', 'global']);

// Soft cap on the in-memory known-projects cache. The Set preserves insertion
// order, so once full we drop the oldest entry on the next miss. Prevents an
// authenticated attacker from inflating per-isolate memory by spraying
// distinct project ids.
const KNOWN_PROJECTS_MAX = 1024;
const knownProjects = new Set<string>();

function rememberKnown(id: string): void {
  if (knownProjects.has(id)) return;
  if (knownProjects.size >= KNOWN_PROJECTS_MAX) {
    const oldest = knownProjects.values().next().value;
    if (oldest !== undefined) knownProjects.delete(oldest);
  }
  knownProjects.add(id);
}

export const projectScopeMiddleware = createMiddleware<AppType>(async (c, next) => {
  const path = new URL(c.req.url).pathname;

  // WebSocket events accept a signed connect-token instead of headers,
  // because the browser WS API can't send custom headers. The token is
  // minted via POST /api/v1/events/token using header-bound scope and the
  // signature ties the claims to the deployment's AUTH_TOKEN.
  if (path === '/api/v1/events') {
    const wsToken = c.req.query('ws_token');
    if (wsToken) {
      const claims = await verifyConnectToken(c.env, wsToken);
      if (!claims) {
        return c.json({ error: 'Invalid or expired ws_token' }, 401);
      }
      // Token validation enforces charset at mint time, but re-check here so
      // a future signing-key change can't accept a token with a malformed id.
      if (!isValidScopeId(claims.projectId) || !isValidScopeId(claims.userId)) {
        return c.json({ error: 'Invalid scope ids in ws_token claims' }, 401);
      }
      c.set('projectId', claims.projectId);
      c.set('userId', claims.userId);
      rememberKnown(claims.projectId);
      await next();
      return;
    }
  }

  const headerId = c.req.header('X-Project-Id');
  const queryId = c.req.query('project_id');

  // Conflicting header + query param indicates a confused-deputy attempt.
  // Reject without picking a side so the caller learns to send one value.
  if (headerId && queryId && headerId !== queryId) {
    return c.json(
      { error: 'Conflicting X-Project-Id header and project_id query param' },
      400
    );
  }

  let projectId: string;
  if (headerId) {
    projectId = headerId;
  } else if (queryId) {
    // QP fallback exists for browser WebSocket opens and similar header-less
    // contexts (iframe postMessage bridges, image-tag beacons). Limit it to
    // GET so a missing/forged header can't redirect a write into another
    // tenant — writes must use the header.
    if (c.req.method !== 'GET') {
      return c.json(
        {
          error:
            'project_id query param is only accepted on GET requests; use the X-Project-Id header for writes',
        },
        400
      );
    }
    projectId = queryId;
  } else {
    projectId = 'default';
  }

  if (!isValidScopeId(projectId)) {
    return c.json(
      { error: 'Invalid project_id: must match [a-zA-Z0-9][a-zA-Z0-9_-]{0,63}' },
      400
    );
  }

  // Project-management endpoints must bypass the registration gate
  // (otherwise you can't register the first project) and the cross-
  // scope atlas is deliberately project-agnostic.
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
    rememberKnown(projectId);
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
  rememberKnown(projectId);
}
