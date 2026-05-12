import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import contextRoutes from '../../src/routes/context';
import * as contextModule from '../../src/memory/context';
import type { AppType } from '../../src/types';
import {
  applyMigrations,
  clearAllTables,
  seedProject,
} from '../helpers/setup';

const PROJECT_ID = 'test-project-cache';
const USER_ID = 'cache-user';

/**
 * Tiny Hono app that wires the real /api/v1/context handler with the
 * project/user scope variables already set, mirroring what the auth +
 * scope middleware do in production. Lets us exercise the cache layer
 * end-to-end against Miniflare's KV without booting the full worker.
 */
function buildApp() {
  const app = new Hono<AppType>();
  app.use('*', async (c, next) => {
    c.set('projectId', PROJECT_ID);
    c.set('userId', USER_ID);
    await next();
  });
  app.route('/', contextRoutes);
  return app;
}

function postContext(body: unknown) {
  return new Request('http://local/api/v1/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/v1/context — KV cache', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    await seedProject(env.DB, PROJECT_ID);
    vi.restoreAllMocks();
  });

  it('returns X-Cache: MISS on first call and HIT on repeat with identical body', async () => {
    const spy = vi.spyOn(contextModule, 'buildContext');
    const app = buildApp();
    const body = { query: 'what is cf-agent-memory' };

    const r1 = await app.fetch(postContext(body), env);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('X-Cache')).toBe('MISS');

    const r2 = await app.fetch(postContext(body), env);
    expect(r2.status).toBe(200);
    expect(r2.headers.get('X-Cache')).toBe('HIT');

    // buildContext should run exactly once across the two calls.
    expect(spy).toHaveBeenCalledTimes(1);

    // Cached body must match the original response.
    expect(await r2.json()).toEqual(await r1.json());
  });

  it('treats key-reordered bodies as cache hits (canonicalization)', async () => {
    const app = buildApp();
    const body1 = {
      query: 'canonical test',
      include: ['short_term', 'long_term'],
      limits: { messages: 5, entities: 5 },
    };
    const body2 = {
      // Same fields, different key order in include and limits.
      include: ['long_term', 'short_term'],
      limits: { entities: 5, messages: 5 },
      query: 'canonical test',
    };

    const r1 = await app.fetch(postContext(body1), env);
    const r2 = await app.fetch(postContext(body2), env);

    expect(r1.headers.get('X-Cache')).toBe('MISS');
    expect(r2.headers.get('X-Cache')).toBe('HIT');
  });

  it('issues separate cache entries when the query text changes', async () => {
    const app = buildApp();
    const r1 = await app.fetch(postContext({ query: 'first query' }), env);
    const r2 = await app.fetch(postContext({ query: 'second query' }), env);
    expect(r1.headers.get('X-Cache')).toBe('MISS');
    expect(r2.headers.get('X-Cache')).toBe('MISS');
  });

  it('does not cache partial-failure responses', async () => {
    // Force buildContext to return a partial failure for one call.
    const spy = vi
      .spyOn(contextModule, 'buildContext')
      .mockResolvedValueOnce({
        context: 'partial',
        errors: [{ source: 'test', message: 'simulated' }],
      });

    const app = buildApp();
    const body = { query: 'partial failure path' };

    const r1 = await app.fetch(postContext(body), env);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('X-Cache')).toBe('MISS');
    expect(((await r1.json()) as { errors?: unknown }).errors).toBeTruthy();

    // Second call must not see a cache hit — the failure response was skipped.
    spy.mockRestore();
    const r2 = await app.fetch(postContext(body), env);
    expect(r2.headers.get('X-Cache')).toBe('MISS');
  });

  it('isolates cache entries by tenant', async () => {
    const app = buildApp();
    const otherApp = new Hono<AppType>();
    otherApp.use('*', async (c, next) => {
      c.set('projectId', 'different-project');
      c.set('userId', USER_ID);
      await next();
    });
    otherApp.route('/', contextRoutes);

    // Seed the second project so its scope middleware would have something
    // to bind against if it ran (here we set the var directly).
    await seedProject(env.DB, 'different-project');

    const body = { query: 'tenant isolation check' };
    const r1 = await app.fetch(postContext(body), env);
    const r2 = await otherApp.fetch(postContext(body), env);
    expect(r1.headers.get('X-Cache')).toBe('MISS');
    expect(r2.headers.get('X-Cache')).toBe('MISS');
  });
});
