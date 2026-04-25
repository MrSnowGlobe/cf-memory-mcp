import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppType } from './types';
import { HttpError } from './utils/errors';
import { authMiddleware } from './middleware/auth';
import { loginHandler, logoutHandler, meHandler } from './auth/session';
import { projectScopeMiddleware } from './middleware/project-scope';
import { userScopeMiddleware } from './middleware/user-scope';
import { aiRateLimitMiddleware, globalRateLimitMiddleware } from './middleware/rate-limit';
import mcpServer from './mcp/server';

import projectsRoutes from './routes/projects';
import usersRoutes from './routes/users';
import sessionsRoutes from './routes/sessions';
import entitiesRoutes from './routes/entities';
import preferencesRoutes from './routes/preferences';
import factsRoutes from './routes/facts';
import tracesRoutes from './routes/traces';
import contextRoutes from './routes/context';
import eventsRoutes from './routes/events';

const app = new Hono<AppType>();

// ---------------------------------------------------------------------------
// Global error handler — maps typed errors to HTTP status codes.
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as ContentfulStatusCode);
  }
  const message = err instanceof Error ? err.message : '';
  if (message.includes('UNIQUE constraint')) {
    return c.json({ error: 'Resource already exists' }, 409);
  }
  // Workers AI throws plain Errors when its capacity bucket empties; a
  // burst against an embed-heavy route surfaces 60+ of these per second.
  // Map them to 429 with Retry-After so callers can back off; otherwise
  // the existing fallthrough returns 500 and a polite client retries
  // forever.
  if (
    message.includes('rate limit') ||
    message.includes('rate-limited') ||
    message.includes('rate limited') ||
    message.includes('Capacity temporarily exceeded') ||
    message.includes('AbortError') && message.includes('AI')
  ) {
    c.header('Retry-After', '10');
    return c.json({ error: 'AI capacity exceeded — back off and retry', code: 'AI_RATE_LIMITED' }, 429);
  }
  console.error('[router] unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

// ---------------------------------------------------------------------------
// Security headers on all responses
// ---------------------------------------------------------------------------

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Cache-Control', 'no-store');
});

// ---------------------------------------------------------------------------
// Health check (no auth required)
// ---------------------------------------------------------------------------

app.get('/health', (c) => c.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// Browser session auth — no bearer/cookie required to hit /auth/*
// ---------------------------------------------------------------------------

app.post('/auth/login', loginHandler);
app.post('/auth/logout', logoutHandler);
app.get('/auth/me', meHandler);

// ---------------------------------------------------------------------------
// Apply middleware to all API and MCP routes
// ---------------------------------------------------------------------------

app.use('/api/*', authMiddleware);
app.use('/api/*', projectScopeMiddleware);
app.use('/api/*', userScopeMiddleware);
app.use('/mcp/*', authMiddleware);
app.use('/mcp/*', projectScopeMiddleware);
app.use('/mcp/*', userScopeMiddleware);

// Broad per-tenant cap — stands in for an edge-level WAF rule.
app.use('/api/*', globalRateLimitMiddleware);
app.use('/mcp/*', globalRateLimitMiddleware);

// Rate-limit AI-bound routes. Writes embed new content; search + context
// embed the query. Non-AI reads (list/get by id) are intentionally excluded
// so a paused embedding quota doesn't block snapshot/atlas rendering.
app.on(['POST', 'PUT'], '/api/v1/*', aiRateLimitMiddleware);
app.use('/api/v1/*/search', aiRateLimitMiddleware);
app.use('/api/v1/context', aiRateLimitMiddleware);

// ---------------------------------------------------------------------------
// Mount domain route modules. Each file owns its slice; this file just wires
// them up in the order matching the previous monolithic layout so that more-
// specific paths (e.g. /entities/search) take precedence over :id captures.
// ---------------------------------------------------------------------------

app.route('/', projectsRoutes);
app.route('/', usersRoutes);
app.route('/', sessionsRoutes);
app.route('/', entitiesRoutes);
app.route('/', preferencesRoutes);
app.route('/', factsRoutes);
app.route('/', tracesRoutes);
app.route('/', contextRoutes);
app.route('/', eventsRoutes);

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

app.route('/mcp', mcpServer);

// ---------------------------------------------------------------------------
// Catch-all: return JSON 404 for any unmatched routes.
// ---------------------------------------------------------------------------

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;
