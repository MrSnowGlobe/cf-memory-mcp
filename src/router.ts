import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppType } from './types';
import { HttpError } from './utils/errors';
import { authMiddleware } from './middleware/auth';
import { loginHandler, logoutHandler, meHandler } from './auth/session';
import { projectScopeMiddleware } from './middleware/project-scope';
import { userScopeMiddleware } from './middleware/user-scope';
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
